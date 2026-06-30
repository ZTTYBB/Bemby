import { TelegramClient, Api, Logger } from 'telegram';
import { db } from '../db/database';
import { LogLevel } from 'telegram/extensions/Logger';
import { StringSession } from 'telegram/sessions';
import type { TgProxy } from '../types';
import type { TgDeviceParams } from '../auth/tgAuth';
import { NewMessage, NewMessageEvent, Raw } from 'telegram/events';

export type CheckinAttemptLog = {
  attempt: number;
  commandSent: string;
  hasMedia: boolean;
  commandResponseHtml: string;
  commandResponseImages?: string[];
  availableButtons: string[][];
  buttonClicked?: string;
  callbackAnswer?: string;
  buttonResponseHtml?: string;
  buttonResponseHasMedia?: boolean;
  buttonResponseImage?: string;
  buttonResponseButtons?: string[][];
  /** Set when {aiBtn} was used; records how long the AI took to pick a button */
  aiDurationMs?: number;
  /** The exact prompt text sent to the AI */
  aiPrompt?: string;
  /** The raw response text returned by the AI */
  aiResponse?: string;
  /** Failed AI responses from earlier attempts, when the first attempt(s) didn't match any button */
  aiRetries?: string[];
  error?: string;
  // Dev timing fields
  connectMs?: number;
  replyLatencyMs?: number;
  buttonClickMs?: number;
  buttonResponseMs?: number;
  /** Whether the button response came via a message edit or a new message */
  buttonResponseSource?: 'edit' | 'new_message';
  totalMs?: number;
  replyTimeoutMs?: number;
  errorName?: string;
};

export class CheckinError extends Error {
  constructor(message: string, public readonly log: CheckinAttemptLog) {
    super(message);
    this.name = 'CheckinError';
  }
}

// Carries partial messages when timeout fires before a buttons-message arrives
class BotReplyTimeoutError extends Error {
  constructor(ms: number, public readonly partial: Api.Message[]) {
    super(`Timed out after ${ms}ms waiting for bot reply`);
    this.name = 'BotReplyTimeoutError';
  }
}

// ── Command template expansion ────────────────────────────────────────────────

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const ALNUM = LOWER + UPPER + DIGITS;

function pick(chars: string, len: number): string {
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/**
 * Expands template placeholders before sending a command.
 * Syntax: {type} or {type:length}
 * Types: word (lowercase), WORD (uppercase), num (digits), alpha (mixed alnum), uuid
 */
export function expandCommand(template: string): string {
  return template.replace(/\{(\w+)(?::(\d+))?\}/g, (match, type: string, lenStr?: string) => {
    const len = lenStr ? parseInt(lenStr, 10) : 0;
    switch (type) {
      case 'word':  return pick(LOWER, len || 6);
      case 'WORD':  return pick(UPPER, len || 6);
      case 'num':   return pick(DIGITS, len || 6);
      case 'alpha': return pick(ALNUM, len || 8);
      case 'uuid': {
        // RFC 4122 v4
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
      }
      default: return match; // unknown placeholder — leave as-is
    }
  });
}

// ── Shared Telegram helpers (also used by custom.ts) ─────────────────────────

export type ParsedMessages = {
  html: string;
  hasMedia: boolean;
  /** All photos in the message group, as base64 data URLs */
  images: string[];
  buttons: string[][];
};

// ── AI button selection ───────────────────────────────────────────────────────

// Strips HTML tags to plain text for the AI prompt
export function htmlToText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function getAiSetting(key: string, fallbackEnv: string, defaultVal: string): string {
  const rows = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return rows?.value || process.env[fallbackEnv] || defaultVal;
}

/** Returns true if the value is an aiBtn placeholder (with or without hint) */
export function isAiBtn(val: string): boolean {
  return val === '{aiBtn}' || /^\{aiBtn:.+\}$/.test(val);
}

/** Extracts the hint from {aiBtn:hint}, returns undefined for plain {aiBtn} */
export function parseAiBtnHint(val: string): string | undefined {
  const m = val.match(/^\{aiBtn:(.+)\}$/);
  return m ? m[1].trim() : undefined;
}

/** Generic AI call: sends images + prompt, returns the raw text response. */
export async function callAI(
  images: string[],
  prompt: string,
  maxTokens = 200,
  modelOverride?: string,
): Promise<{ response: string }> {
  const model = modelOverride?.trim() || getAiSetting('ai_model', 'AI_MODEL', 'nvidia/nemotron-nano-12b-v2-vl:free');

  // Resolve credentials from the suppliers table (model_id → supplier)
  type SupplierCreds = { api_key: string; base_url: string; timeout_ms: number };
  const supplierRow = db.prepare(`
    SELECT s.api_key, s.base_url, s.timeout_ms
    FROM ai_models m JOIN ai_suppliers s ON s.id = m.supplier_id
    WHERE m.model_id = ? LIMIT 1
  `).get(model) as SupplierCreds | undefined;

  const apiKey  = supplierRow?.api_key  ?? getAiSetting('ai_api_key',   'AI_API_KEY',  '');
  const baseUrl = (supplierRow?.base_url ?? getAiSetting('ai_base_url', 'AI_BASE_URL', 'https://openrouter.ai/api/v1')).replace(/\/$/, '');
  const AI_TIMEOUT_MS = supplierRow ? supplierRow.timeout_ms : Number(getAiSetting('ai_timeout_ms', 'AI_TIMEOUT_MS', '25000'));

  if (!apiKey) throw new Error('AI API key not configured — set it in Settings');

  const content: object[] = [];
  for (const img of images) content.push({ type: 'image_url', image_url: { url: img } });
  content.push({ type: 'text', text: prompt });

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: maxTokens }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AI API error ${res.status}: ${body}`);
  }

  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  const response = data.choices?.[0]?.message?.content?.trim() ?? '';
  return { response };
}

/** Returns true if a command template contains an {aiInput} or {aiInput:N} placeholder */
export function hasAiInput(template: string): boolean {
  return /\{aiInput(?::\d+)?\}/.test(template);
}

/** Extracts the expected length from {aiInput:N}, returns undefined for plain {aiInput} */
export function parseAiInputLength(template: string): number | undefined {
  const m = template.match(/\{aiInput:(\d+)\}/);
  return m ? parseInt(m[1], 10) : undefined;
}

type AiInputResult = { text: string; prompt: string; response: string };

/** Builds the captcha recognition prompt so callers can log it before the fetch. */
export function buildCaptchaPrompt(length?: number): string {
  const lengthHint = length ? ` The captcha is exactly ${length} characters.` : '';
  return `Read this captcha image.${lengthHint} Reply with ONLY the captcha characters, nothing else.`;
}

/** Sends captcha image(s) to the AI and returns the recognised text only. */
export async function recognizeCaptchaWithAI(
  images: string[],
  length?: number,
): Promise<AiInputResult> {
  const apiKey = getAiSetting('ai_api_key', 'AI_API_KEY', '');
  if (!apiKey) throw new Error('{aiInput} requires an AI API key — configure it in Settings');
  if (!images.length) throw new Error('{aiInput} requires an image in the previous message');

  const baseUrl = getAiSetting('ai_base_url', 'AI_BASE_URL', 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const model = getAiSetting('ai_model', 'AI_MODEL', 'nvidia/nemotron-nano-12b-v2-vl:free');

  const prompt = buildCaptchaPrompt(length);

  const content: object[] = [];
  for (const img of images) content.push({ type: 'image_url', image_url: { url: img } });
  content.push({ type: 'text', text: prompt });

  const AI_TIMEOUT_MS = Number(getAiSetting('ai_timeout_ms', 'AI_TIMEOUT_MS', '25000'));
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: 20 }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AI API error ${res.status}: ${body}`);
  }

  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  const recognized = data.choices?.[0]?.message?.content?.trim() ?? '';
  if (!recognized) throw new Error('AI returned empty response for captcha recognition');

  return { text: recognized, prompt, response: recognized };
}

type AiSelectionResult = { button: string; prompt: string; response: string; retries: string[] };

export async function selectButtonWithAI(
  buttons: string[][],
  html: string,
  images: string[],
  hint?: string,
  maxRetries = 0,
): Promise<AiSelectionResult> {
  const apiKey = getAiSetting('ai_api_key', 'AI_API_KEY', '');
  if (!apiKey) throw new Error('{aiBtn} requires an AI API key — configure it in Settings');

  const baseUrl = getAiSetting('ai_base_url', 'AI_BASE_URL', 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const model = getAiSetting('ai_model', 'AI_MODEL', 'nvidia/nemotron-nano-12b-v2-vl:free');

  const flat = buttons.flat();
  const text = htmlToText(html);
  const task = hint ?? ('pick ONE button based on the message' + (images.length ? ' and attached image(s).' : ''));
  const prompt = `Task: "${task}".\n\nThe message:\n${text}\n\nThe available inline buttons are: ${JSON.stringify(flat)}\n\nWhich button should be clicked to "${task}"? If you don't know which button, please pick the most likely one. You MUST reply with ONLY the EXACT BUTTON TEXT from the available list, nothing else. Do NOT include any thinking logic.`;

  const content: object[] = [];
  for (const img of images) content.push({ type: 'image_url', image_url: { url: img } });
  content.push({ type: 'text', text: prompt });

  const AI_TIMEOUT_MS = Number(getAiSetting('ai_timeout_ms', 'AI_TIMEOUT_MS', '25000'));
  const effectiveMax = Math.min(maxRetries, 5); // hard cap to avoid exhausting AI credits
  const failedResponses: string[] = [];

  for (let attempt = 0; attempt <= effectiveMax; attempt++) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: 50 }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`AI API error ${res.status}: ${body}`);
    }

    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const picked = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!picked) throw new Error('AI API returned an empty response');

    const exact = flat.find(b => b === picked);
    if (exact) return { button: exact, prompt, response: picked, retries: failedResponses };
    const partial = flat.find(b => b.includes(picked) || picked.includes(b));
    if (partial) return { button: partial, prompt, response: picked, retries: failedResponses };
    // No match -- log this attempt and retry
    failedResponses.push(picked);
  }

  const err = new Error(`AI selected "${failedResponses.at(-1)}" but it does not match any available button after ${effectiveMax + 1} attempt(s): ${JSON.stringify(flat)}`);
  (err as any).aiRetries = failedResponses;
  (err as any).aiPrompt = prompt;
  (err as any).aiResponse = failedResponses.at(-1) ?? '';
  throw err;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeHref(url: string): string {
  try {
    return /^(https?|tg):$/i.test(new URL(url).protocol) ? url : '';
  } catch {
    return '';
  }
}

function messageToHtml(text: string, entities?: Api.TypeMessageEntity[]): string {
  if (!entities?.length) return escapeHtml(text).replace(/\n/g, '<br>');

  type Ins = { pos: number; html: string; isClose: boolean };
  const ins: Ins[] = [];

  for (const e of entities) {
    const end = e.offset + e.length;
    if (e instanceof Api.MessageEntityBold) {
      ins.push({ pos: e.offset, html: '<strong>', isClose: false });
      ins.push({ pos: end, html: '</strong>', isClose: true });
    } else if (e instanceof Api.MessageEntityItalic) {
      ins.push({ pos: e.offset, html: '<em>', isClose: false });
      ins.push({ pos: end, html: '</em>', isClose: true });
    } else if (e instanceof Api.MessageEntityCode) {
      ins.push({ pos: e.offset, html: '<code>', isClose: false });
      ins.push({ pos: end, html: '</code>', isClose: true });
    } else if (e instanceof Api.MessageEntityPre) {
      ins.push({ pos: e.offset, html: '<pre>', isClose: false });
      ins.push({ pos: end, html: '</pre>', isClose: true });
    } else if (e instanceof Api.MessageEntityUnderline) {
      ins.push({ pos: e.offset, html: '<u>', isClose: false });
      ins.push({ pos: end, html: '</u>', isClose: true });
    } else if (e instanceof Api.MessageEntityStrike) {
      ins.push({ pos: e.offset, html: '<s>', isClose: false });
      ins.push({ pos: end, html: '</s>', isClose: true });
    } else if (e instanceof Api.MessageEntityUrl) {
      const safe = safeHref(text.slice(e.offset, end));
      if (safe) {
        ins.push({ pos: e.offset, html: `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener">`, isClose: false });
        ins.push({ pos: end, html: '</a>', isClose: true });
      }
    } else if (e instanceof Api.MessageEntityTextUrl) {
      const safe = safeHref((e as Api.MessageEntityTextUrl).url ?? '');
      if (safe) {
        ins.push({ pos: e.offset, html: `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener">`, isClose: false });
        ins.push({ pos: end, html: '</a>', isClose: true });
      }
    } else if (e instanceof Api.MessageEntityBotCommand) {
      ins.push({ pos: e.offset, html: '<span style="color:#2563eb">', isClose: false });
      ins.push({ pos: end, html: '</span>', isClose: true });
    }
  }

  // Sort: by position; close tags before open tags at same position (correct nesting)
  ins.sort((a, b) => a.pos - b.pos || (a.isClose ? -1 : 1) - (b.isClose ? -1 : 1));

  let result = '';
  let pos = 0;
  for (const { pos: iPos, html } of ins) {
    if (iPos > pos) result += escapeHtml(text.slice(pos, iPos));
    result += html;
    pos = iPos;
  }
  result += escapeHtml(text.slice(pos));
  return result.replace(/\n/g, '<br>');
}

// Renders a Telegram web page preview as inline HTML (inline styles required for v-html)
function webpageToHtml(wp: Api.WebPage): string {
  const site = escapeHtml(wp.siteName || wp.displayUrl || '');
  const title = escapeHtml(wp.title ?? '');
  const desc = escapeHtml(wp.description ?? '');
  let html = '<div style="border-left:3px solid #4a9eff;padding:3px 0 3px 8px;margin-top:6px;font-size:12px;line-height:1.4">';
  if (site) html += `<div style="color:#4a9eff;font-weight:500">${site}</div>`;
  if (title) html += `<div style="font-weight:600;color:#111">${title}</div>`;
  if (desc) html += `<div style="color:#555;margin-top:1px">${desc}</div>`;
  html += '</div>';
  return html;
}

// Extracts display data from a set of bot messages
export async function parseMessages(
  messages: Api.Message[],
  client: TelegramClient,
  signal?: AbortSignal,
): Promise<ParsedMessages> {
  const hasMedia = messages.some(
    m => m.media instanceof Api.MessageMediaPhoto || m.media instanceof Api.MessageMediaDocument,
  );

  const htmlParts: string[] = [];
  for (const m of messages) {
    const textHtml = messageToHtml(m.message, m.entities as Api.TypeMessageEntity[] | undefined);
    let msgHtml = textHtml;
    if (m.media instanceof Api.MessageMediaWebPage && m.media.webpage instanceof Api.WebPage) {
      msgHtml += webpageToHtml(m.media.webpage);
    }
    if (msgHtml.trim()) htmlParts.push(msgHtml);
  }
  const html = htmlParts.join('<hr style="margin:8px 0;border:none;border-top:1px solid #d0d0d0">');

  const buttons: string[][] = [];
  const buttonsMsg = [...messages].reverse().find(m => (m as any).replyMarkup instanceof Api.ReplyInlineMarkup);
  if (buttonsMsg) {
    const markup = (buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup;
    for (const row of markup.rows) {
      const rowTexts = row.buttons.map(btn => (btn as any).text as string).filter(Boolean);
      if (rowTexts.length) buttons.push(rowTexts);
    }
  }

  const images: string[] = [];
  if (!signal?.aborted) {
    for (const m of messages) {
      if (!(m.media instanceof Api.MessageMediaPhoto)) continue;
      try {
        const photo = m.media.photo;
        if (photo instanceof Api.Photo) {
          const mSize = photo.sizes.find(
            (s): s is Api.PhotoSize => s instanceof Api.PhotoSize && s.type === 'm'
          ) ?? photo.sizes[1] ?? photo.sizes[0];
          if (mSize) {
            const bytes = await client.downloadMedia(m, { thumb: mSize }) as Buffer | undefined;
            if (bytes) images.push(`data:image/jpeg;base64,${bytes.toString('base64')}`);
          }
        }
      } catch { /* skip image on error */ }
    }
  }

  return { html, hasMedia, images, buttons };
}

// Collects ALL bot messages; resolves when one has buttons, times out otherwise
function waitForBotReply(
  client: TelegramClient,
  botUsername: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Api.Message[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Job cancelled')); return; }

    const collected: Api.Message[] = [];

    const cleanup = () => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      signal?.removeEventListener('abort', onAbort);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new BotReplyTimeoutError(timeoutMs, collected));
    }, timeoutMs);

    const onAbort = () => { cleanup(); reject(new Error('Job cancelled')); };
    signal?.addEventListener('abort', onAbort, { once: true });

    const handler = async (event: NewMessageEvent) => {
      const msg = event.message as Api.Message;
      collected.push(msg);
      // Use replyMarkup (raw TLObject field) instead of msg.buttons getter, which
      // requires inputChat to be resolved and silently returns undefined when it isn't.
      if ((msg as any).replyMarkup) { cleanup(); resolve(collected); }
    };

    client.addEventHandler(handler, new NewMessage({ fromUsers: [botUsername] }));
  });
}

// Watches for an in-place edit of a specific message (bot edits the original reply).
// Uses raw Telegram updates since GramJS has no dedicated EditedMessage event.
// Never rejects -- resolves null on timeout or abort.
export function waitForBotMessageEdit(
  client: TelegramClient,
  originalMsgId: number,
  maxMs: number,
  signal?: AbortSignal,
): Promise<Api.Message | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(null); return; }

    const finish = (msg: Api.Message | null) => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new Raw({}));
      signal?.removeEventListener('abort', onAbort);
      resolve(msg);
    };

    const timer = setTimeout(() => finish(null), maxMs);
    const onAbort = () => finish(null);
    signal?.addEventListener('abort', onAbort, { once: true });

    const handler = async (update: any) => {
      const isEdit =
        update.className === 'UpdateEditMessage' ||
        update.className === 'UpdateEditChannelMessage';
      if (isEdit) {
        const msg = update.message as Api.Message;
        // Catch any inbound edit from the bot (not our own outgoing messages).
        // Some bots edit a different message than the one that had the buttons.
        if (msg && !msg.out) finish(msg);
      }
    };

    client.addEventHandler(handler, new Raw({}));
  });
}

// Waits for any new message from the bot within the given timeout.
// Never rejects -- resolves null on timeout or abort.
export function waitForNewBotMessage(
  client: TelegramClient,
  botUsername: string,
  maxMs: number,
  signal?: AbortSignal,
): Promise<Api.Message | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(null); return; }

    const finish = (msg: Api.Message | null) => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      signal?.removeEventListener('abort', onAbort);
      resolve(msg);
    };

    const timer = setTimeout(() => finish(null), maxMs);
    const onAbort = () => finish(null);
    signal?.addEventListener('abort', onAbort, { once: true });

    const handler = async (event: NewMessageEvent) => {
      finish(event.message as Api.Message);
    };

    client.addEventHandler(handler, new NewMessage({ fromUsers: [botUsername] }));
  });
}

export type SpamStatus = "free" | "limited" | "blocked" | "frozen" | "unknown";

function parseSpamStatus(text: string): SpamStatus {
  const lower = text.toLowerCase();
  if (lower.includes("good news") || lower.includes("no limits") || lower.includes("free as a bird")) return "free";
  if (lower.includes("permanently") || lower.includes("banned") || lower.includes("suspended")) return "blocked";
  // SpamBot says "blocked" for frozen accounts (temporary restriction, not a permanent ban)
  if (lower.includes("frozen") || lower.includes("blocked")) return "frozen";
  if (lower.includes("limited")) return "limited";
  return "unknown";
}

export async function checkSpamStatus(
  apiId: number,
  apiHash: string,
  sessionString: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<{ spamStatus: SpamStatus; rawMessage: string }> {
  const SPAM_BOT = "SpamBot";
  const TIMEOUT_MS = 25_000;

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
    autoReconnect: false,
    baseLogger: new Logger(LogLevel.NONE),
    ...(proxy ? { proxy } : {}),
    ...(deviceParams ?? {}),
  });

  await client.connect();

  try {
    // Set up listener BEFORE sending to avoid missing a fast reply
    const replyPromise = new Promise<{ text: string; id: number }>((resolve, reject) => {
      let done = false;

      const finish = (result: { text: string; id: number } | Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        client.removeEventHandler(handler, new NewMessage({}));
        if (result instanceof Error) reject(result);
        else resolve(result);
      };

      const timer = setTimeout(() => finish(new Error("SpamBot did not reply in time")), TIMEOUT_MS);

      const handler = async (event: NewMessageEvent) => {
        const msg = event.message as Api.Message;
        const text = (msg.message ?? "").trim();
        if (text) finish({ text, id: msg.id });
      };

      client.addEventHandler(handler, new NewMessage({ fromUsers: [SPAM_BOT] }));
    });

    await client.sendMessage(SPAM_BOT, { message: "/start" });
    const { text: rawMessage, id: replyId } = await replyPromise;

    // Mark SpamBot conversation as read so it doesn't show as unread in the chat list
    try {
      const spamBotEntity = await client.getEntity(SPAM_BOT);
      await client.invoke(new Api.messages.ReadHistory({ peer: spamBotEntity, maxId: replyId }));
    } catch { /* non-critical, ignore */ }

    return { spamStatus: parseSpamStatus(rawMessage), rawMessage };
  } finally {
    try { await client.disconnect(); } catch { /* ignore */ }
  }
}

export async function runCheckin(
  apiId: number,
  apiHash: string,
  sessionString: string,
  botUsername: string,
  replyTimeoutMs = 40_000,
  startCommand = '/start',
  checkinButton = '签到',
  attempt = 1,
  maxAiRetries = 0,
  signal?: AbortSignal,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
  successContains?: string,
  failContains?: string,
): Promise<CheckinAttemptLog> {
  const attemptStart = Date.now();
  const log: CheckinAttemptLog = {
    attempt, commandSent: startCommand, hasMedia: false,
    commandResponseHtml: '', availableButtons: [] as string[][],
    replyTimeoutMs,
  };

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
    autoReconnect: false,
    baseLogger: new Logger(LogLevel.NONE),
    ...(proxy ? { proxy } : {}),
    ...(deviceParams ?? {}),
  });

  const t_connect = Date.now();
  await client.connect();
  log.connectMs = Date.now() - t_connect;

  try {
    if (signal?.aborted) throw new Error('Job cancelled');
    const expandedCommand = expandCommand(startCommand);
    log.commandSent = expandedCommand; // record what was actually sent, not the template
    const replyPromise = waitForBotReply(client, botUsername, replyTimeoutMs, signal);
    const t_send = Date.now();
    await client.sendMessage(botUsername, { message: expandedCommand });

    let messages: Api.Message[];
    try {
      messages = await replyPromise;
      log.replyLatencyMs = Date.now() - t_send;
    } catch (err) {
      log.replyLatencyMs = Date.now() - t_send;
      if (err instanceof BotReplyTimeoutError && err.partial.length > 0) {
        const parsed = await parseMessages(err.partial, client, signal);
        log.hasMedia = parsed.hasMedia;
        log.commandResponseHtml = parsed.html;
        log.commandResponseImages = parsed.images;
        log.availableButtons = parsed.buttons;
      }
      throw err;
    }

    const parsed = await parseMessages(messages, client, signal);
    log.hasMedia = parsed.hasMedia;
    log.commandResponseHtml = parsed.html;
    log.commandResponseImages = parsed.images;
    log.availableButtons = parsed.buttons;

    const buttonsMsg = [...messages].reverse().find(m => (m as any).replyMarkup instanceof Api.ReplyInlineMarkup);
    if (!buttonsMsg) throw new Error('No message with buttons received');

    if (signal?.aborted) throw new Error('Job cancelled');

    const markup = (buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup;
    const allBtnRows = markup.rows;

    // Resolve target button text and match mode
    let targetText: string;
    let useExactMatch: boolean;

    if (checkinButton === '{anyBtn}') {
      const flat = allBtnRows.flatMap(row => row.buttons.map((btn: any) => btn.text as string));
      if (!flat.length) throw new Error('No buttons available for {anyBtn}');
      targetText = flat[Math.floor(Math.random() * flat.length)];
      useExactMatch = true;
    } else if (isAiBtn(checkinButton)) {
      const aiStart = Date.now();
      const hint = parseAiBtnHint(checkinButton);
      const aiResult = await selectButtonWithAI(log.availableButtons, log.commandResponseHtml, parsed.images, hint, maxAiRetries);
      targetText = aiResult.button;
      log.aiDurationMs = Date.now() - aiStart;
      log.aiPrompt = aiResult.prompt;
      log.aiResponse = aiResult.response;
      if (aiResult.retries.length) log.aiRetries = aiResult.retries;
      useExactMatch = true;
    } else {
      targetText = checkinButton;
      useExactMatch = false;
    }

    const peer = await client.getInputEntity(botUsername);
    let clicked = false;

    for (const row of allBtnRows) {
      for (const btn of row.buttons) {
        const btnText = (btn as any).text as string;
        const matches = useExactMatch ? btnText === targetText : btnText.includes(targetText);
        if (matches) {
          if (!(btn instanceof Api.KeyboardButtonCallback)) {
            const typeName = (btn as any).className ?? btn.constructor?.name ?? 'unknown';
            throw new Error(
              `Button "${btnText}" is a ${typeName}, not a callback button — only KeyboardButtonCallback can be clicked automatically`,
            );
          }

          // Start watching BEFORE invoking to avoid missing a fast response.
          // Edit listener catches any inbound bot edit (not just the buttons message).
          const editPromise = waitForBotMessageEdit(client, buttonsMsg.id, replyTimeoutMs, signal);
          const newMsgPromise = waitForNewBotMessage(client, botUsername, replyTimeoutMs, signal);

          const t_click = Date.now();
          const answer = await client.invoke(new Api.messages.GetBotCallbackAnswer({
            peer,
            msgId: buttonsMsg.id,
            data: btn.data,
          })) as Api.messages.BotCallbackAnswer;
          log.buttonClickMs = Date.now() - t_click;
          log.buttonClicked = btnText;
          if (answer.message) log.callbackAnswer = answer.message;
          console.log(`[checkin] callback answer: message="${answer.message ?? ''}" url="${(answer as any).url ?? ''}" alert=${(answer as any).alert ?? false}`);
          clicked = true;

          // If the bot already confirmed via toast (answer.message), allow a short
          // grace window for any follow-up edit/message; otherwise wait longer.
          const capMs = answer.message
            ? Math.min(replyTimeoutMs, 5_000)
            : Math.min(replyTimeoutMs, 30_000);
          const capPromise = new Promise<{ msg: null; src: 'cap' }>(r =>
            setTimeout(() => r({ msg: null, src: 'cap' }), capMs),
          );

          // Take whichever response arrives first; track the source for dev logs
          const t_resp = Date.now();
          const taggedEdit = editPromise.then(m => ({ msg: m, src: 'edit' as const }));
          const taggedNew = newMsgPromise.then(m => ({ msg: m, src: 'new_message' as const }));
          const { msg: responseMsg, src: respSrc } = await Promise.race([taggedEdit, taggedNew, capPromise]);
          log.buttonResponseMs = Date.now() - t_resp;
          if (responseMsg && !signal?.aborted) {
            log.buttonResponseSource = respSrc;
            const bp = await parseMessages([responseMsg], client, signal);
            if (bp.html || bp.hasMedia) {
              log.buttonResponseHtml = bp.html || undefined;
              log.buttonResponseHasMedia = bp.hasMedia || undefined;
              log.buttonResponseImage = bp.images[0];
              log.buttonResponseButtons = bp.buttons.length ? bp.buttons : undefined;
            }
          }
          break;
        }
      }
      if (clicked) break;
    }

    const notFoundLabel = isAiBtn(checkinButton) ? `{aiBtn} -> "${targetText}"` : `"${checkinButton}"`;
    if (!clicked) throw new Error(`Button ${notFoundLabel} not found in bot reply`);

    // Check success/fail text in callback answer or button response
    if (successContains || failContains) {
      const texts = [log.callbackAnswer ?? '', htmlToText(log.buttonResponseHtml ?? '')].filter(Boolean).join('\n');
      if (failContains && texts.includes(failContains)) {
        throw new Error(`Reply indicates failure: "${failContains}" detected`);
      }
      if (successContains && !texts.includes(successContains)) {
        throw new Error(`Expected success indicator "${successContains}" not found in response`);
      }
    }

    log.totalMs = Date.now() - attemptStart;
    return log;
  } catch (err: any) {
    log.error = err?.message ?? String(err);
    log.errorName = err?.name ?? err?.constructor?.name;
    log.totalMs = Date.now() - attemptStart;
    if (Array.isArray(err?.aiRetries) && err.aiRetries.length) log.aiRetries = err.aiRetries;
    throw new CheckinError(log.error!, log);
  } finally {
    // GramJS throws TIMEOUT when the update loop stops on disconnect; always swallow here
    try { await client.disconnect(); } catch { /* ignore */ }
  }
}
