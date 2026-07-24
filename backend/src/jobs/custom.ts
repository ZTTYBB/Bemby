import { TelegramClient, Api, Logger, utils } from "telegram";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import type { TgProxy } from '../types';
import type { TgDeviceParams } from '../auth/tgAuth';
import { NewMessage, NewMessageEvent, Raw } from "telegram/events";
import {
  expandCommand,
  selectButtonWithAI,
  selectMultipleButtonsWithAI,
  parseMessages,
  waitForBotMessageEdit,
  waitForNewBotMessage,
  isAiBtn,
  parseAiBtnHint,
  hasAiInput,
  parseAiInputLength,
  recognizeCaptchaWithAI,
  buildCaptchaPrompt,
} from "./checkin";
import type { CustomConfig, CustomStepLog } from "../types";

export type CustomJobLog = {
  steps: CustomStepLog[];
};

export class CustomJobError extends Error {
  constructor(
    message: string,
    public readonly log: CustomJobLog,
  ) {
    super(message);
    this.name = "CustomJobError";
  }
}

// Marker of the last message we sent: anything the bot delivered after this point
// (higher id, or an edit stamped after our send) is a candidate reply. Anchoring on the
// sent message's server-side id/date avoids local clock skew.
type SendAnchor = { msgId: number; dateSec: number };

const hasInlineButtons = (m: Api.Message | null | undefined): boolean =>
  !!m && (m as any).replyMarkup instanceof Api.ReplyInlineMarkup;

const anchorFromSent = (sent: Api.Message): SendAnchor => ({
  msgId: sent.id,
  dateSec: sent.date ?? Math.floor(Date.now() / 1000),
});

const isEditUpdate = (update: any): boolean =>
  update?.className === "UpdateEditMessage" ||
  update?.className === "UpdateEditChannelMessage";

// Lowest message id an action will accept for a given scope. scope 0 (default)
// admits only messages newer than the anchor -- the reply to what we just sent,
// which stops a stale menu from an earlier turn being clicked. scope -N also
// admits the N most recent incoming messages that predate the anchor, for bots
// whose live menu sits on an earlier message. anchorId 0 (nothing sent yet)
// falls back to accepting everything.
async function resolveScopeFloor(
  client: TelegramClient,
  target: Api.TypeEntityLike,
  anchorId: number,
  scope?: number,
): Promise<number> {
  const freshFloor = anchorId + 1;
  if (!scope || scope >= 0) return freshFloor;
  const n = -scope;
  const recent = (await client
    .getMessages(target, { limit: n + 20 })
    .catch(() => [])) as Api.Message[];
  const prior = recent
    .filter((m) => m && !m.out && m.id <= anchorId)
    .map((m) => m.id)
    .sort((a, b) => b - a); // newest first
  if (!prior.length) return freshFloor;
  return prior[Math.min(n, prior.length) - 1];
}

// Authoritative membership check: GetParticipant throws USER_NOT_PARTICIPANT for pending
// join requests, unlike the Channel.left flag which can lag behind actual state.
async function isChannelMember(client: TelegramClient, channel: Api.Channel): Promise<boolean> {
  try {
    const result = await client.invoke(
      new Api.channels.GetParticipant({ channel, participant: "me" }),
    );
    return !(result.participant instanceof Api.ChannelParticipantLeft);
  } catch (err: any) {
    if (err?.message?.includes("USER_NOT_PARTICIPANT")) return false;
    throw err;
  }
}

// Waits for a message carrying inline buttons in a specific chat (e.g. the group we just
// joined). Buttons can arrive on a brand-new message OR via an in-place edit of an
// existing message, so both update paths are watched.
async function waitForButtonsInChat(
  client: TelegramClient,
  chat: Api.TypeEntityLike,
  maxMs: number,
  signal?: AbortSignal,
  minId = 0,
): Promise<Api.Message[]> {
  const chatPeerId = await client.getPeerId(chat);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Job cancelled"));
      return;
    }

    const collected: Api.Message[] = [];

    const cleanup = () => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      client.removeEventHandler(editHandler, new Raw({}));
      signal?.removeEventListener("abort", onAbort);
    };

    const succeed = (msg: Api.Message) => {
      cleanup();
      if (!collected.includes(msg)) collected.push(msg);
      resolve(collected);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`No message with buttons received within ${maxMs}ms`));
    }, maxMs);

    const onAbort = () => {
      cleanup();
      reject(new Error("Job cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const handler = async (event: NewMessageEvent) => {
      const msg = event.message as Api.Message;
      collected.push(msg);
      if (hasInlineButtons(msg)) succeed(msg);
    };

    const editHandler = async (update: any) => {
      if (!isEditUpdate(update)) return;
      const msg = update.message as Api.Message;
      if (!msg || msg.out) return;
      if (msg.id < minId) return; // out of scope (edit of a pre-anchor message)
      if (!msg.peerId || utils.getPeerId(msg.peerId) !== chatPeerId) return;
      if (hasInlineButtons(msg)) succeed(msg);
    };

    client.addEventHandler(handler, new NewMessage({ chats: [chat] }));
    client.addEventHandler(editHandler, new Raw({}));
  });
}

// Waits for the next new message arriving in a specific chat. Never rejects -- resolves null
// on timeout or abort.
async function waitForNewMessageInChat(
  client: TelegramClient,
  chat: Api.TypeEntityLike,
  maxMs: number,
  signal?: AbortSignal,
): Promise<Api.Message | null> {
  // Resolve the chat id up front and match it manually. Passing an entity object into
  // NewMessage({ chats }) breaks GramJS -- its constructor stringifies each filter entry
  // to "[object Object]", then throws an unhandled rejection resolving it on the next update.
  const targetId = await client.getPeerId(chat).catch(() => null);
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    const finish = (msg: Api.Message | null) => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      signal?.removeEventListener("abort", onAbort);
      resolve(msg);
    };
    const timer = setTimeout(() => finish(null), maxMs);
    const onAbort = () => finish(null);
    signal?.addEventListener("abort", onAbort, { once: true });
    const handler = async (event: NewMessageEvent) => {
      if (
        targetId != null &&
        event.message?.chatId?.toString() !== targetId.toString()
      )
        return;
      finish(event.message as Api.Message);
    };
    client.addEventHandler(handler, new NewMessage({}));
  });
}

// Some groups post an in-group verification message with a button that must be clicked to
// gain real access after joining. Best-effort: waits for that message, clicks the button whose
// text contains buttonMatch (or the sole button), and appends the outcome to step.result.
async function clickGroupVerification(
  client: TelegramClient,
  chat: Api.Channel,
  buttonMatch: string,
  maxMs: number,
  step: CustomStepLog,
  signal?: AbortSignal,
  sinceSec?: number,
): Promise<void> {
  const findButtonsMsg = (msgs: Api.Message[]): Api.Message | null =>
    [...msgs].reverse().find((m) => hasInlineButtons(m)) ?? null;

  // Waiter catches prompts that arrive (or get edited in) from now on; the scan catches a
  // prompt that landed in the gap before the listener attached. Whichever finds one first wins.
  const waitAbort = new AbortController();
  const forwardAbort = () => waitAbort.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });

  const waiterPromise = waitForButtonsInChat(client, chat, maxMs, waitAbort.signal)
    .then(findButtonsMsg)
    .catch(() => null);

  const earlyScan = client
    .getMessages(chat, { limit: 10 })
    .then(
      (recent) =>
        (recent as Api.Message[]).find(
          (m) =>
            m &&
            !m.out &&
            hasInlineButtons(m) &&
            (!sinceSec || Math.max(m.editDate ?? 0, m.date ?? 0) >= sinceSec),
        ) ?? null,
    )
    .catch(() => null);

  let buttonsMsg = await Promise.race([
    waiterPromise,
    earlyScan.then((m) => m ?? waiterPromise),
  ]);
  waitAbort.abort();
  signal?.removeEventListener("abort", forwardAbort);
  if (signal?.aborted) throw new Error("Job cancelled");

  // Last resort: any recent prompt regardless of age
  if (!buttonsMsg) {
    const recent = (await client.getMessages(chat, { limit: 10 })) as Api.Message[];
    buttonsMsg = findButtonsMsg(recent);
  }

  if (!buttonsMsg) {
    step.result = `${step.result} (no verification prompt)`;
    return;
  }

  const rows = ((buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup).rows;
  const flat = rows.flatMap((r) => r.buttons);
  const match = buttonMatch.trim();
  let target = match
    ? flat.find((b: any) => ((b.text as string) ?? "").includes(match))
    : undefined;
  // Fall back to the sole button for single-button verifications.
  if (!target && flat.length === 1) target = flat[0];
  if (!target) {
    step.result = `${step.result} (verification button not found)`;
    return;
  }

  const data = (target as Api.KeyboardButtonCallback).data;
  if (!data) {
    step.result = `${step.result} (verification button not clickable)`;
    return;
  }

  const peer = await client.getInputEntity(chat);
  step.clickedButton = (target as any).text as string;
  try {
    const answer = (await client.invoke(
      new Api.messages.GetBotCallbackAnswer({ peer, msgId: buttonsMsg.id, data }),
    )) as Api.messages.BotCallbackAnswer;
    if (answer.message) step.callbackAnswer = answer.message;
    step.result = `${step.result} + verified`;
  } catch (err: any) {
    // The callback reached the bot but it never answered -- common for verification bots
    // that process the click without calling answerCallbackQuery. The click was delivered,
    // so treat the verification as done rather than failing the whole join.
    if (err?.message?.includes("BOT_RESPONSE_TIMEOUT")) {
      step.result = `${step.result} + verify clicked (no bot confirmation)`;
    } else {
      throw err;
    }
  }
}

// Collects messages from the target until one has buttons or timeout fires.
// When successContains/failContains are set, checks message text to resolve or reject early.
// Watches new messages AND in-place edits; when sinceAnchor is given, also scans recent
// history so a reply that landed before the listener attached is not lost.
async function waitForReply(
  client: TelegramClient,
  fromUsername: string,
  maxMs: number,
  successContains?: string,
  failContains?: string,
  signal?: AbortSignal,
  minId = 0,
): Promise<Api.Message[]> {
  const botPeerId = await client.getPeerId(fromUsername);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Job cancelled"));
      return;
    }

    const collected: Api.Message[] = [];
    const useTextMatch = !!(successContains || failContains);
    let done = false;

    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      client.removeEventHandler(editHandler, new Raw({}));
      signal?.removeEventListener("abort", onAbort);
    };

    const timer = setTimeout(() => {
      cleanup();
      if (useTextMatch) {
        reject(new Error(`Expected reply not received within ${maxMs}ms`));
      } else if (collected.length > 0) {
        resolve(collected);
      } else {
        reject(new Error(`No reply received within ${maxMs}ms`));
      }
    }, maxMs);

    const onAbort = () => {
      cleanup();
      reject(new Error("Job cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // Replace an earlier copy on edit, otherwise append
    const upsert = (msg: Api.Message) => {
      const i = collected.findIndex((c) => c.id === msg.id);
      if (i >= 0) collected[i] = msg;
      else collected.push(msg);
    };

    const consider = (msg: Api.Message) => {
      if (done) return;
      upsert(msg);
      const text = msg.message ?? "";

      if (failContains && text.includes(failContains)) {
        cleanup();
        reject(
          new Error(`Reply indicates failure: "${failContains}" detected`),
        );
        return;
      }

      if (successContains) {
        if (text.includes(successContains)) {
          cleanup();
          resolve(collected);
        }
        // Keep waiting for a message that matches the success text
        return;
      }

      // failContains only (no successContains) -- any non-fail message is a success
      if (failContains) {
        cleanup();
        resolve(collected);
        return;
      }

      // No text matching -- original behaviour: resolve immediately on buttons, else rely on timeout
      if (hasInlineButtons(msg)) {
        cleanup();
        resolve(collected);
      }
    };

    const handler = async (event: NewMessageEvent) =>
      consider(event.message as Api.Message);

    const editHandler = async (update: any) => {
      if (!isEditUpdate(update)) return;
      const msg = update.message as Api.Message;
      if (!msg || msg.out) return;
      if (msg.id < minId) return; // out of scope (edit of a pre-anchor message)
      if (!msg.peerId || utils.getPeerId(msg.peerId) !== botPeerId) return;
      consider(msg);
    };

    client.addEventHandler(
      handler,
      new NewMessage({ fromUsers: [fromUsername] }),
    );
    client.addEventHandler(editHandler, new Raw({}));

    // Best-effort: pick up replies delivered in the send-to-listen gap
    if (minId > 1) {
      client
        .getMessages(fromUsername, { limit: 10 })
        .then((recent) => {
          const missed = (recent as Api.Message[])
            .filter(
              (m) =>
                m &&
                !m.out &&
                m.id >= minId &&
                !collected.some((c) => c.id === m.id),
            )
            .reverse(); // process oldest first
          for (const m of missed) consider(m);
        })
        .catch(() => {
          /* history scan is best-effort */
        });
    }
  });
}

// Waits specifically for a message with inline buttons from the target. Buttons may show
// up on a brand-new message OR via an in-place edit of an earlier one; when sinceAnchor is
// given, recent history is also scanned to cover the gap before the listeners attached.
// excludeId skips one known message (e.g. the one whose buttons we already tried).
async function waitForButtonsMessage(
  client: TelegramClient,
  fromUsername: string,
  maxMs: number,
  signal?: AbortSignal,
  minId = 0,
  excludeId?: number,
): Promise<Api.Message[]> {
  const botPeerId = await client.getPeerId(fromUsername);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Job cancelled"));
      return;
    }

    const collected: Api.Message[] = [];
    let done = false;

    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      client.removeEventHandler(editHandler, new Raw({}));
      signal?.removeEventListener("abort", onAbort);
    };

    const succeed = (msg: Api.Message) => {
      if (done) return;
      cleanup();
      if (!collected.some((c) => c.id === msg.id)) collected.push(msg);
      resolve(collected);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`No message with buttons received within ${maxMs}ms`));
    }, maxMs);

    const onAbort = () => {
      cleanup();
      reject(new Error("Job cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const handler = async (event: NewMessageEvent) => {
      const msg = event.message as Api.Message;
      collected.push(msg);
      if (hasInlineButtons(msg)) succeed(msg);
    };

    const editHandler = async (update: any) => {
      if (!isEditUpdate(update)) return;
      const msg = update.message as Api.Message;
      if (!msg || msg.out) return;
      if (msg.id < minId) return; // out of scope (edit of a pre-anchor message)
      if (!msg.peerId || utils.getPeerId(msg.peerId) !== botPeerId) return;
      if (hasInlineButtons(msg)) succeed(msg);
    };

    client.addEventHandler(
      handler,
      new NewMessage({ fromUsers: [fromUsername] }),
    );
    client.addEventHandler(editHandler, new Raw({}));

    // Best-effort: a buttons message may have landed in the send-to-listen gap.
    // getMessages returns newest-first, so this seeds the most recent in-scope
    // match ("last available button").
    if (minId > 1) {
      client
        .getMessages(fromUsername, { limit: 10 })
        .then((recent) => {
          const seed = (recent as Api.Message[]).find(
            (m) =>
              m &&
              !m.out &&
              m.id !== excludeId &&
              m.id >= minId &&
              hasInlineButtons(m),
          );
          if (seed) succeed(seed);
        })
        .catch(() => {
          /* history scan is best-effort */
        });
    }
  });
}

export async function runCustom(
  apiId: number,
  apiHash: string,
  sessionString: string,
  botUsername: string,
  config: CustomConfig,
  signal?: AbortSignal,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<CustomJobLog> {
  const log: CustomJobLog = { steps: [] };
  const jobMaxRetries = config.maxRetries ?? 1;

  const client = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    {
      connectionRetries: 5,
      autoReconnect: false,
      baseLogger: new Logger(LogLevel.NONE),
      ...(proxy ? { proxy } : {}),
      ...(deviceParams ?? {}),
    },
  );

  try {
    await client.connect();

    let lastJobError: unknown = null;

    for (let jobAttempt = 1; jobAttempt <= jobMaxRetries; jobAttempt++) {
      if (signal?.aborted) throw new Error("Job cancelled");

      // State shared across actions within this job attempt
      let lastMessages: Api.Message[] = [];
      let lastButtonsMsg: Api.Message | null = null;
      let sendAnchor: SendAnchor | null = null;
      // Last message we sent to each specific contact, keyed by the trimmed
      // contact handle -- the scope anchor for click_message_button.
      const contactAnchors = new Map<string, SendAnchor>();
      let jobAttemptFailed = false;

      for (let i = 0; i < config.actions.length; i++) {
        if (signal?.aborted) throw new Error("Job cancelled");

        const action = config.actions[i];
        const actionMaxRetries =
          action.type !== "delay" && "maxRetries" in action
            ? (action.maxRetries ?? 0)
            : 0;

        let actionSucceeded = false;

        for (
          let actionAttempt = 1;
          actionAttempt <= actionMaxRetries + 1 && !actionSucceeded;
          actionAttempt++
        ) {
          const step: CustomStepLog = {
            step: i + 1,
            actionType: action.type,
            label: "",
            ...(jobMaxRetries > 1 ? { jobAttempt } : {}),
            ...(actionMaxRetries > 0 ? { actionAttempt } : {}),
          };
          log.steps.push(step);
          const t0 = Date.now();

          try {
            switch (action.type) {
              case "enter_captcha": {
                const lengthHint = action.captchaLength
                  ? ` (${action.captchaLength} chars)`
                  : "";
                step.label = `Enter captcha${lengthHint}`;
                let msgs: Api.Message[];
                if (lastMessages.length > 0) {
                  msgs = lastMessages;
                } else {
                  msgs = await waitForReply(
                    client,
                    botUsername,
                    action.maxWaitMs,
                    undefined,
                    undefined,
                    signal,
                    sendAnchor ? sendAnchor.msgId + 1 : 0,
                  );
                  lastMessages = msgs;
                }
                const parsed = await parseMessages(msgs, client, signal);
                if (parsed.html) step.preClickHtml = parsed.html;
                if (parsed.images[0]) step.preClickImage = parsed.images[0];
                if (parsed.hasMedia) step.preClickHasMedia = parsed.hasMedia;
                step.aiPrompt = buildCaptchaPrompt(action.captchaLength);
                const aiStart = Date.now();
                const aiResult = await recognizeCaptchaWithAI(
                  parsed.images,
                  action.captchaLength,
                )
                  .then((r) => {
                    step.aiResponse = r.response;
                    return r;
                  })
                  .finally(() => {
                    step.aiDurationMs = Date.now() - aiStart;
                  });
                if (
                  action.captchaLength &&
                  aiResult.text.length !== action.captchaLength
                ) {
                  throw new Error(
                    `AI returned ${aiResult.text.length} chars ("${aiResult.text}") but expected ${action.captchaLength}`,
                  );
                }
                const sentCaptcha = await client.sendMessage(botUsername, {
                  message: aiResult.text,
                });
                lastMessages = [];
                lastButtonsMsg = null;
                sendAnchor = anchorFromSent(sentCaptcha);
                step.result = `Sent: "${aiResult.text}"`;
                break;
              }

              case "send_command": {
                let content = action.content;
                if (hasAiInput(content)) {
                  const length = parseAiInputLength(content);
                  const parsed = await parseMessages(
                    lastMessages,
                    client,
                    signal,
                  );
                  if (parsed.images[0]) step.preClickImage = parsed.images[0];
                  step.aiPrompt = buildCaptchaPrompt(length);
                  const aiStart = Date.now();
                  const aiResult = await recognizeCaptchaWithAI(
                    parsed.images,
                    length,
                  )
                    .then((r) => {
                      step.aiResponse = r.response;
                      return r;
                    })
                    .finally(() => {
                      step.aiDurationMs = Date.now() - aiStart;
                    });
                  if (length && aiResult.text.length !== length) {
                    throw new Error(
                      `AI returned ${aiResult.text.length} chars ("${aiResult.text}") but expected ${length}`,
                    );
                  }
                  content = content.replace(
                    /\{aiInput(?::\d+)?\}/,
                    aiResult.text,
                  );
                }
                const expanded = expandCommand(content);
                step.label = `Send: "${expanded}"`;
                const sentCmd = await client.sendMessage(botUsername, {
                  message: expanded,
                });
                lastMessages = [];
                lastButtonsMsg = null;
                sendAnchor = anchorFromSent(sentCmd);
                step.result = "Sent";
                break;
              }

              case "send_contact_message": {
                const contact = action.contact.trim();
                const entity = await client.getEntity(contact);
                let content = action.content;
                if (hasAiInput(content)) {
                  const length = parseAiInputLength(content);
                  const parsed = await parseMessages(
                    lastMessages,
                    client,
                    signal,
                  );
                  if (parsed.images[0]) step.preClickImage = parsed.images[0];
                  step.aiPrompt = buildCaptchaPrompt(length);
                  const aiStart = Date.now();
                  const aiResult = await recognizeCaptchaWithAI(
                    parsed.images,
                    length,
                  )
                    .then((r) => {
                      step.aiResponse = r.response;
                      return r;
                    })
                    .finally(() => {
                      step.aiDurationMs = Date.now() - aiStart;
                    });
                  if (length && aiResult.text.length !== length) {
                    throw new Error(
                      `AI returned ${aiResult.text.length} chars ("${aiResult.text}") but expected ${length}`,
                    );
                  }
                  content = content.replace(
                    /\{aiInput(?::\d+)?\}/,
                    aiResult.text,
                  );
                }
                const expanded = expandCommand(content);
                step.label = `Send to ${contact}: "${expanded}"`;
                const sentContact = await client.sendMessage(entity, {
                  message: expanded,
                });
                contactAnchors.set(contact, anchorFromSent(sentContact));
                step.result = "Sent";
                break;
              }

              case "wait_reply": {
                const { successContains, failContains } = action;
                const hints = [
                  successContains ? `success: "${successContains}"` : "",
                  failContains ? `fail: "${failContains}"` : "",
                ]
                  .filter(Boolean)
                  .join(", ");
                step.label = `Wait reply (max ${action.maxWaitMs}ms)${hints ? ` [${hints}]` : ""}`;
                const minId = await resolveScopeFloor(
                  client,
                  botUsername,
                  sendAnchor?.msgId ?? 0,
                  action.scope,
                );
                const msgs = await waitForReply(
                  client,
                  botUsername,
                  action.maxWaitMs,
                  successContains,
                  failContains,
                  signal,
                  minId,
                );
                lastMessages = msgs;
                step.msgCount = msgs.length;
                const btnMsg =
                  [...msgs].reverse().find((m) => hasInlineButtons(m)) ?? null;
                if (btnMsg) lastButtonsMsg = btnMsg;
                const parsed = await parseMessages(msgs, client, signal);
                step.responseHtml = parsed.html || undefined;
                step.responseImage = parsed.images[0];
                step.responseHasMedia = parsed.hasMedia || undefined;
                step.responseButtons = parsed.buttons.length
                  ? parsed.buttons
                  : undefined;
                step.result = `Received ${msgs.length} message(s)`;
                break;
              }

              case "delay": {
                step.label = `Delay ${action.waitMs}ms`;
                await new Promise<void>((res, rej) => {
                  if (signal?.aborted) {
                    rej(new Error("Job cancelled"));
                    return;
                  }
                  const timer = setTimeout(res, action.waitMs);
                  signal?.addEventListener(
                    "abort",
                    () => {
                      clearTimeout(timer);
                      rej(new Error("Job cancelled"));
                    },
                    { once: true },
                  );
                });
                step.result = "Done";
                break;
              }

              case "click_button": {
                step.label = `Click button "${action.button}"`;

                const minId = await resolveScopeFloor(
                  client,
                  botUsername,
                  sendAnchor?.msgId ?? 0,
                  action.scope,
                );
                // Ignore a cached buttons message that falls outside the scope
                // (e.g. a menu from before the command we just sent).
                let buttonsMsg: Api.Message | null =
                  lastButtonsMsg && lastButtonsMsg.id >= minId
                    ? lastButtonsMsg
                    : null;
                let preClickImages: string[] = [];
                if (buttonsMsg) {
                  // The bot may have edited the message since we captured it (swapped or
                  // added buttons); refresh so we click against the current markup
                  const currentId: number = buttonsMsg.id;
                  const fresh: Api.Message | null = await client
                    .getMessages(botUsername, { ids: [currentId] })
                    .then((r) => (r as Api.Message[])?.[0] ?? null)
                    .catch(() => null);
                  if (hasInlineButtons(fresh)) {
                    buttonsMsg = fresh;
                    lastButtonsMsg = fresh;
                  }
                }
                if (!buttonsMsg) {
                  const msgs = await waitForButtonsMessage(
                    client,
                    botUsername,
                    action.maxWaitMs,
                    signal,
                    minId,
                  );
                  lastMessages = msgs;
                  buttonsMsg =
                    [...msgs].reverse().find((m) => hasInlineButtons(m)) ??
                    null;
                  if (buttonsMsg) lastButtonsMsg = buttonsMsg;
                  const preParsed = await parseMessages(msgs, client, signal);
                  if (preParsed.html) step.preClickHtml = preParsed.html;
                  if (preParsed.images.length) {
                    step.preClickImage = preParsed.images[0];
                    preClickImages = preParsed.images;
                  }
                  if (preParsed.hasMedia)
                    step.preClickHasMedia = preParsed.hasMedia;
                  if (preParsed.buttons.length)
                    step.preClickButtons = preParsed.buttons;
                }
                if (!buttonsMsg)
                  throw new Error("No message with buttons available");

                const btnMarkup = (buttonsMsg as any)
                  .replyMarkup as Api.ReplyInlineMarkup;
                const allBtnRows = btnMarkup.rows;
                const flat = allBtnRows.flatMap((row) =>
                  row.buttons.map((b: any) => b.text as string),
                );

                let targetText: string;
                let useExactMatch: boolean;

                if (action.button === "{anyBtn}") {
                  if (!flat.length)
                    throw new Error("No buttons available for {anyBtn}");
                  targetText = flat[Math.floor(Math.random() * flat.length)];
                  useExactMatch = true;
                } else if (isAiBtn(action.button)) {
                  const buttons: string[][] = allBtnRows.map((row) =>
                    row.buttons.map((b: any) => b.text as string),
                  );
                  const hint = parseAiBtnHint(action.button);
                  if (!step.preClickHtml && !preClickImages.length) {
                    const parsed = await parseMessages(
                      [buttonsMsg],
                      client,
                      signal,
                    );
                    if (parsed.html) step.preClickHtml = parsed.html;
                    if (parsed.images.length) {
                      step.preClickImage = parsed.images[0];
                      preClickImages = parsed.images;
                    }
                    if (parsed.hasMedia)
                      step.preClickHasMedia = parsed.hasMedia;
                    if (parsed.buttons.length)
                      step.preClickButtons = parsed.buttons;
                  }
                  const aiStart = Date.now();
                  const aiResult = await selectButtonWithAI(
                    buttons,
                    step.preClickHtml ?? buttonsMsg.message ?? "",
                    preClickImages,
                    hint,
                    action.maxRetries,
                  )
                    .then((r) => {
                      step.aiPrompt = r.prompt;
                      step.aiResponse = r.response;
                      if (r.retries.length) step.aiRetries = r.retries;
                      return r;
                    })
                    .finally(() => {
                      step.aiDurationMs = Date.now() - aiStart;
                    });
                  targetText = aiResult.button;
                  useExactMatch = true;
                } else {
                  targetText = action.button;
                  useExactMatch = false;
                }

                const peer = await client.getInputEntity(botUsername);
                const botPeerId = await client.getPeerId(botUsername);
                let clicked = false;
                let retryCount = 0;

                const markupContainsTarget = (
                  m: Api.Message | null,
                ): boolean =>
                  hasInlineButtons(m) &&
                  ((m as any).replyMarkup as Api.ReplyInlineMarkup).rows.some(
                    (row) =>
                      row.buttons.some((b: any) => {
                        const t = ((b.text as string) ?? "");
                        return useExactMatch
                          ? t === targetText
                          : t.includes(targetText);
                      }),
                  );

                for (
                  let attempt = 0;
                  attempt <= action.maxRetries && !clicked;
                  attempt++
                ) {
                  if (attempt > 0) {
                    retryCount = attempt;
                    // Target may have appeared via an in-place edit of the message we
                    // already have -- refresh it before waiting for a different one
                    const fresh: Api.Message | null = await client
                      .getMessages(botUsername, { ids: [buttonsMsg!.id] })
                      .then((r) => (r as Api.Message[])?.[0] ?? null)
                      .catch(() => null);
                    if (hasInlineButtons(fresh)) {
                      buttonsMsg = fresh;
                      lastButtonsMsg = fresh;
                    }
                    if (!markupContainsTarget(buttonsMsg)) {
                      const msgs: Api.Message[] | null =
                        await waitForButtonsMessage(
                          client,
                          botUsername,
                          action.maxWaitMs,
                          signal,
                          minId,
                          buttonsMsg?.id,
                        ).catch(() => null);
                      if (msgs) {
                        lastMessages = msgs;
                        const bm: Api.Message | undefined = [...msgs]
                          .reverse()
                          .find((m) => hasInlineButtons(m));
                        if (bm) {
                          buttonsMsg = bm;
                          lastButtonsMsg = bm;
                        }
                      }
                    }
                  }

                  const rows = (
                    (buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup
                  ).rows;
                  for (const row of rows) {
                    for (const btn of row.buttons) {
                      const btnText = (btn as any).text as string;
                      const matches = useExactMatch
                        ? btnText === targetText
                        : btnText.includes(targetText);
                      if (!matches) continue;

                      // Abort controller scoped to this click attempt -- prevents stale listeners
                      // from interfering with later steps if GetBotCallbackAnswer throws.
                      const clickAbort = new AbortController();
                      const forwardAbort = () => clickAbort.abort();
                      signal?.addEventListener("abort", forwardAbort, {
                        once: true,
                      });

                      const editPromise = waitForBotMessageEdit(
                        client,
                        buttonsMsg!.id,
                        10_000,
                        clickAbort.signal,
                        botPeerId,
                      );
                      const newMsgPromise = waitForNewBotMessage(
                        client,
                        botUsername,
                        10_000,
                        clickAbort.signal,
                      );

                      const callbackData = (btn as Api.KeyboardButtonCallback)
                        .data;
                      const preClickEditDate = (buttonsMsg as any).editDate as
                        | number
                        | undefined;
                      let answer: Api.messages.BotCallbackAnswer | null = null;
                      let callbackTimedOut = false;
                      try {
                        answer = (await client.invoke(
                          new Api.messages.GetBotCallbackAnswer({
                            peer,
                            msgId: buttonsMsg!.id,
                            data: callbackData,
                          }),
                        )) as Api.messages.BotCallbackAnswer;
                      } catch (err: any) {
                        // BOT_RESPONSE_TIMEOUT means the click reached the bot but it never
                        // called answerCallbackQuery -- the action may still have taken effect
                        // (e.g. the bot edited the message). Fall through and let the edit/
                        // new-message watchers below decide whether it actually succeeded.
                        if (!err?.message?.includes("BOT_RESPONSE_TIMEOUT")) {
                          clickAbort.abort();
                          signal?.removeEventListener("abort", forwardAbort);
                          throw err;
                        }
                        callbackTimedOut = true;
                      }

                      if (answer?.message) step.callbackAnswer = answer.message;
                      clicked = true;
                      step.retryCount = retryCount;

                      const taggedEdit = editPromise.then((m) => ({
                        msg: m,
                        src: "edit" as const,
                      }));
                      const taggedNew = newMsgPromise.then((m) => ({
                        msg: m,
                        src: "new_message" as const,
                      }));
                      const first = await Promise.race([taggedEdit, taggedNew]);
                      // Bots often edit the clicked message AND send a follow-up; when the
                      // first response carries no buttons, give the other source a short
                      // window -- the next step's buttons are usually there
                      let second:
                        | { msg: Api.Message | null; src: "edit" | "new_message" }
                        | null = null;
                      if (first.msg && !hasInlineButtons(first.msg)) {
                        const other =
                          first.src === "edit" ? taggedNew : taggedEdit;
                        second = await Promise.race([
                          other,
                          new Promise<null>((r) =>
                            setTimeout(() => r(null), 1_500),
                          ),
                        ]);
                      }
                      clickAbort.abort();
                      signal?.removeEventListener("abort", forwardAbort);

                      const responses = [first, second].filter(
                        (
                          r,
                        ): r is { msg: Api.Message; src: "edit" | "new_message" } =>
                          !!r?.msg && !signal?.aborted,
                      );
                      if (responses.length) {
                        const primary =
                          responses.find((r) => hasInlineButtons(r.msg)) ??
                          responses[0];
                        step.responseSource = primary.src;
                        lastMessages = responses.map((r) => r.msg);
                        if (hasInlineButtons(primary.msg))
                          lastButtonsMsg = primary.msg;
                        const parsed = await parseMessages(
                          lastMessages,
                          client,
                          signal,
                        );
                        step.responseHtml = parsed.html || undefined;
                        step.responseImage = parsed.images[0];
                        step.responseHasMedia = parsed.hasMedia || undefined;
                        step.responseButtons = parsed.buttons.length
                          ? parsed.buttons
                          : undefined;
                      }

                      // A timed-out callback only counts as a failure if the bot never
                      // reacted. If no edit/new message was seen live, re-fetch the clicked
                      // message: a changed editDate proves the bot processed the click.
                      if (callbackTimedOut && !responses.length) {
                        const fresh: Api.Message | null = await client
                          .getMessages(botUsername, { ids: [buttonsMsg!.id] })
                          .then((r) => (r as Api.Message[])?.[0] ?? null)
                          .catch(() => null);
                        const freshEditDate = (fresh as any)?.editDate as
                          | number
                          | undefined;
                        const wasEdited =
                          !!fresh &&
                          !!freshEditDate &&
                          freshEditDate !== preClickEditDate;
                        if (!wasEdited)
                          throw new Error(
                            `Button "${btnText}" click timed out (BOT_RESPONSE_TIMEOUT) with no response`,
                          );
                        step.responseSource = "edit";
                        lastMessages = [fresh!];
                        if (hasInlineButtons(fresh)) lastButtonsMsg = fresh;
                        const parsed = await parseMessages(
                          lastMessages,
                          client,
                          signal,
                        );
                        step.responseHtml = parsed.html || undefined;
                        step.responseImage = parsed.images[0];
                        step.responseHasMedia = parsed.hasMedia || undefined;
                        step.responseButtons = parsed.buttons.length
                          ? parsed.buttons
                          : undefined;
                      }

                      // Check success/fail text in callback answer or response messages
                      if (action.successContains || action.failContains) {
                        const texts = [answer?.message ?? '', ...responses.map((r) => r.msg.message ?? '')].filter(Boolean).join('\n');
                        if (action.failContains && texts.includes(action.failContains)) {
                          throw new Error(`Reply indicates failure: "${action.failContains}" detected`);
                        }
                        if (action.successContains && !texts.includes(action.successContains)) {
                          throw new Error(`Expected success indicator "${action.successContains}" not found in response`);
                        }
                      }

                      step.clickedButton = btnText;
                      step.result = `Clicked "${btnText}"`;
                      break;
                    }
                    if (clicked) break;
                  }
                }

                if (!clicked)
                  throw new Error(
                    `Button "${targetText!}" not found after ${action.maxRetries + 1} attempt(s)`,
                  );
                break;
              }

              case "click_message_button": {
                const contact = action.contact.trim();
                step.label = `Click button "${action.button}" from ${contact}`;

                const entity = await client.getEntity(contact);
                const peer = await client.getInputEntity(entity);
                const chatPeerId = await client.getPeerId(entity);

                const minId = await resolveScopeFloor(
                  client,
                  entity,
                  contactAnchors.get(contact)?.msgId ?? 0,
                  action.scope,
                );
                const findButtonsMsg = (msgs: Api.Message[]): Api.Message | null =>
                  msgs.find((m) => m.id >= minId && hasInlineButtons(m)) ?? null;

                // Seed from the contact's most recent messages (newest first); otherwise wait
                // for an incoming message carrying buttons.
                let buttonsMsg: Api.Message | null = findButtonsMsg(
                  (await client.getMessages(entity, { limit: 10 })) as Api.Message[],
                );
                let preClickImages: string[] = [];
                if (!buttonsMsg) {
                  const msgs = await waitForButtonsInChat(
                    client,
                    entity,
                    action.maxWaitMs,
                    signal,
                    minId,
                  );
                  buttonsMsg =
                    [...msgs].reverse().find((m) => hasInlineButtons(m)) ??
                    null;
                }
                if (buttonsMsg) {
                  const preParsed = await parseMessages(
                    [buttonsMsg],
                    client,
                    signal,
                  );
                  if (preParsed.html) step.preClickHtml = preParsed.html;
                  if (preParsed.images.length) {
                    step.preClickImage = preParsed.images[0];
                    preClickImages = preParsed.images;
                  }
                  if (preParsed.hasMedia)
                    step.preClickHasMedia = preParsed.hasMedia;
                  if (preParsed.buttons.length)
                    step.preClickButtons = preParsed.buttons;
                }
                if (!buttonsMsg)
                  throw new Error("No message with buttons available");

                const btnMarkup = (buttonsMsg as any)
                  .replyMarkup as Api.ReplyInlineMarkup;
                const allBtnRows = btnMarkup.rows;
                const flat = allBtnRows.flatMap((row) =>
                  row.buttons.map((b: any) => b.text as string),
                );

                let targetText: string;
                let useExactMatch: boolean;

                if (action.button === "{anyBtn}") {
                  if (!flat.length)
                    throw new Error("No buttons available for {anyBtn}");
                  targetText = flat[Math.floor(Math.random() * flat.length)];
                  useExactMatch = true;
                } else if (isAiBtn(action.button)) {
                  const buttons: string[][] = allBtnRows.map((row) =>
                    row.buttons.map((b: any) => b.text as string),
                  );
                  const hint = parseAiBtnHint(action.button);
                  const aiStart = Date.now();
                  const aiResult = await selectButtonWithAI(
                    buttons,
                    step.preClickHtml ?? buttonsMsg.message ?? "",
                    preClickImages,
                    hint,
                    action.maxRetries,
                  )
                    .then((r) => {
                      step.aiPrompt = r.prompt;
                      step.aiResponse = r.response;
                      if (r.retries.length) step.aiRetries = r.retries;
                      return r;
                    })
                    .finally(() => {
                      step.aiDurationMs = Date.now() - aiStart;
                    });
                  targetText = aiResult.button;
                  useExactMatch = true;
                } else {
                  targetText = action.button;
                  useExactMatch = false;
                }

                let clicked = false;
                let retryCount = 0;

                const markupContainsTarget = (
                  m: Api.Message | null,
                ): boolean =>
                  hasInlineButtons(m) &&
                  ((m as any).replyMarkup as Api.ReplyInlineMarkup).rows.some(
                    (row) =>
                      row.buttons.some((b: any) => {
                        const t = ((b.text as string) ?? "");
                        return useExactMatch
                          ? t === targetText
                          : t.includes(targetText);
                      }),
                  );

                for (
                  let attempt = 0;
                  attempt <= action.maxRetries && !clicked;
                  attempt++
                ) {
                  if (attempt > 0) {
                    retryCount = attempt;
                    // Target may have appeared via an in-place edit of the message we
                    // already have -- refresh it before waiting for a different one
                    const fresh: Api.Message | null = await client
                      .getMessages(entity, { ids: [buttonsMsg!.id] })
                      .then((r) => (r as Api.Message[])?.[0] ?? null)
                      .catch(() => null);
                    if (hasInlineButtons(fresh)) buttonsMsg = fresh;
                    if (!markupContainsTarget(buttonsMsg)) {
                      const msgs = await waitForButtonsInChat(
                        client,
                        entity,
                        action.maxWaitMs,
                        signal,
                        minId,
                      ).catch(() => null);
                      if (msgs) {
                        const bm = [...msgs]
                          .reverse()
                          .find((m) => hasInlineButtons(m));
                        if (bm) buttonsMsg = bm;
                      }
                    }
                  }

                  const rows = (
                    (buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup
                  ).rows;
                  for (const row of rows) {
                    for (const btn of row.buttons) {
                      const btnText = (btn as any).text as string;
                      const matches = useExactMatch
                        ? btnText === targetText
                        : btnText.includes(targetText);
                      if (!matches) continue;

                      const clickAbort = new AbortController();
                      const forwardAbort = () => clickAbort.abort();
                      signal?.addEventListener("abort", forwardAbort, {
                        once: true,
                      });

                      const editPromise = waitForBotMessageEdit(
                        client,
                        buttonsMsg!.id,
                        10_000,
                        clickAbort.signal,
                        chatPeerId,
                      );
                      const newMsgPromise = waitForNewMessageInChat(
                        client,
                        entity,
                        10_000,
                        clickAbort.signal,
                      );

                      const callbackData = (btn as Api.KeyboardButtonCallback)
                        .data;
                      const preClickEditDate = (buttonsMsg as any).editDate as
                        | number
                        | undefined;
                      let answer: Api.messages.BotCallbackAnswer | null = null;
                      let callbackTimedOut = false;
                      try {
                        answer = (await client.invoke(
                          new Api.messages.GetBotCallbackAnswer({
                            peer,
                            msgId: buttonsMsg!.id,
                            data: callbackData,
                          }),
                        )) as Api.messages.BotCallbackAnswer;
                      } catch (err: any) {
                        // BOT_RESPONSE_TIMEOUT means the click reached the bot but it never
                        // called answerCallbackQuery -- the action may still have taken effect
                        // (e.g. the bot edited the message). Fall through and let the edit/
                        // new-message watchers below decide whether it actually succeeded.
                        if (!err?.message?.includes("BOT_RESPONSE_TIMEOUT")) {
                          clickAbort.abort();
                          signal?.removeEventListener("abort", forwardAbort);
                          throw err;
                        }
                        callbackTimedOut = true;
                      }

                      if (answer?.message) step.callbackAnswer = answer.message;
                      clicked = true;
                      step.retryCount = retryCount;

                      const taggedEdit = editPromise.then((m) => ({
                        msg: m,
                        src: "edit" as const,
                      }));
                      const taggedNew = newMsgPromise.then((m) => ({
                        msg: m,
                        src: "new_message" as const,
                      }));
                      const first = await Promise.race([taggedEdit, taggedNew]);
                      // When the first response carries no buttons, give the other source
                      // a short window in case it delivers the next step's buttons
                      let second:
                        | { msg: Api.Message | null; src: "edit" | "new_message" }
                        | null = null;
                      if (first.msg && !hasInlineButtons(first.msg)) {
                        const other =
                          first.src === "edit" ? taggedNew : taggedEdit;
                        second = await Promise.race([
                          other,
                          new Promise<null>((r) =>
                            setTimeout(() => r(null), 1_500),
                          ),
                        ]);
                      }
                      clickAbort.abort();
                      signal?.removeEventListener("abort", forwardAbort);

                      const responses = [first, second].filter(
                        (
                          r,
                        ): r is { msg: Api.Message; src: "edit" | "new_message" } =>
                          !!r?.msg && !signal?.aborted,
                      );
                      if (responses.length) {
                        const primary =
                          responses.find((r) => hasInlineButtons(r.msg)) ??
                          responses[0];
                        step.responseSource = primary.src;
                        const parsed = await parseMessages(
                          responses.map((r) => r.msg),
                          client,
                          signal,
                        );
                        step.responseHtml = parsed.html || undefined;
                        step.responseImage = parsed.images[0];
                        step.responseHasMedia = parsed.hasMedia || undefined;
                        step.responseButtons = parsed.buttons.length
                          ? parsed.buttons
                          : undefined;
                      }

                      // A timed-out callback only counts as a failure if the bot never
                      // reacted. If no edit/new message was seen live, re-fetch the clicked
                      // message: a changed editDate proves the bot processed the click.
                      if (callbackTimedOut && !responses.length) {
                        const fresh: Api.Message | null = await client
                          .getMessages(entity, { ids: [buttonsMsg!.id] })
                          .then((r) => (r as Api.Message[])?.[0] ?? null)
                          .catch(() => null);
                        const freshEditDate = (fresh as any)?.editDate as
                          | number
                          | undefined;
                        const wasEdited =
                          !!fresh &&
                          !!freshEditDate &&
                          freshEditDate !== preClickEditDate;
                        if (!wasEdited)
                          throw new Error(
                            `Button "${btnText}" click timed out (BOT_RESPONSE_TIMEOUT) with no response`,
                          );
                        step.responseSource = "edit";
                        const parsed = await parseMessages(
                          [fresh!],
                          client,
                          signal,
                        );
                        step.responseHtml = parsed.html || undefined;
                        step.responseImage = parsed.images[0];
                        step.responseHasMedia = parsed.hasMedia || undefined;
                        step.responseButtons = parsed.buttons.length
                          ? parsed.buttons
                          : undefined;
                      }

                      if (action.successContains || action.failContains) {
                        const texts = [answer?.message ?? '', ...responses.map((r) => r.msg.message ?? '')].filter(Boolean).join('\n');
                        if (action.failContains && texts.includes(action.failContains)) {
                          throw new Error(`Reply indicates failure: "${action.failContains}" detected`);
                        }
                        if (action.successContains && !texts.includes(action.successContains)) {
                          throw new Error(`Expected success indicator "${action.successContains}" not found in response`);
                        }
                      }

                      step.clickedButton = btnText;
                      step.result = `Clicked "${btnText}"`;
                      break;
                    }
                    if (clicked) break;
                  }
                }

                if (!clicked)
                  throw new Error(
                    `Button "${targetText!}" not found after ${action.maxRetries + 1} attempt(s)`,
                  );
                break;
              }

              case "ai_multiple_btn": {
                const contact = action.contact?.trim() ?? "";
                const botMode = contact.length === 0;
                step.label = botMode
                  ? "AI multi-click buttons"
                  : `AI multi-click buttons from ${contact}`;

                // Chat context: the job's bot by default, otherwise a named contact.
                const target: Api.TypeEntityLike = botMode
                  ? botUsername
                  : await client.getEntity(contact);
                const peer = await client.getInputEntity(target);
                const editPeerId = await client.getPeerId(target);
                const anchor = botMode
                  ? sendAnchor
                  : (contactAnchors.get(contact) ?? null);
                const minId = await resolveScopeFloor(
                  client,
                  target,
                  anchor?.msgId ?? 0,
                  action.scope,
                );

                const refetch = (id: number): Promise<Api.Message | null> =>
                  client
                    .getMessages(target, { ids: [id] })
                    .then((r) => (r as Api.Message[])?.[0] ?? null)
                    .catch(() => null);
                const waitButtons = (
                  excludeId?: number,
                ): Promise<Api.Message[]> =>
                  botMode
                    ? waitForButtonsMessage(
                        client,
                        botUsername,
                        action.maxWaitMs,
                        signal,
                        minId,
                        excludeId,
                      )
                    : waitForButtonsInChat(
                        client,
                        target,
                        action.maxWaitMs,
                        signal,
                        minId,
                      );
                const waitNewMsg = (
                  timeoutMs: number,
                ): Promise<Api.Message | null> =>
                  botMode
                    ? waitForNewBotMessage(
                        client,
                        botUsername,
                        timeoutMs,
                        signal,
                      )
                    : waitForNewMessageInChat(
                        client,
                        target,
                        timeoutMs,
                        signal,
                      );

                // ── Obtain the message carrying the buttons ──
                let buttonsMsg: Api.Message | null = null;
                let preClickImages: string[] = [];
                if (botMode) {
                  buttonsMsg =
                    lastButtonsMsg && lastButtonsMsg.id >= minId
                      ? lastButtonsMsg
                      : null;
                  if (buttonsMsg) {
                    const fresh = await refetch(buttonsMsg.id);
                    if (hasInlineButtons(fresh)) {
                      buttonsMsg = fresh;
                      lastButtonsMsg = fresh;
                    }
                  }
                } else {
                  const recent = (await client.getMessages(target, {
                    limit: 10,
                  })) as Api.Message[];
                  buttonsMsg =
                    recent.find((m) => m.id >= minId && hasInlineButtons(m)) ??
                    null;
                }
                if (!buttonsMsg) {
                  const msgs = await waitButtons();
                  if (botMode) lastMessages = msgs;
                  buttonsMsg =
                    [...msgs].reverse().find((m) => hasInlineButtons(m)) ?? null;
                  if (buttonsMsg && botMode) lastButtonsMsg = buttonsMsg;
                }
                if (!buttonsMsg)
                  throw new Error("No message with buttons available");

                const preParsed = await parseMessages(
                  [buttonsMsg],
                  client,
                  signal,
                );
                if (preParsed.html) step.preClickHtml = preParsed.html;
                if (preParsed.images.length) {
                  step.preClickImage = preParsed.images[0];
                  preClickImages = preParsed.images;
                }
                if (preParsed.hasMedia) step.preClickHasMedia = preParsed.hasMedia;
                if (preParsed.buttons.length)
                  step.preClickButtons = preParsed.buttons;

                // ── AI picks the ordered list of buttons to click ──
                const buttonRows: string[][] = (
                  (buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup
                ).rows.map((row) => row.buttons.map((b: any) => b.text as string));
                const aiStart = Date.now();
                const aiResult = await selectMultipleButtonsWithAI(
                  buttonRows,
                  step.preClickHtml ?? buttonsMsg.message ?? "",
                  preClickImages,
                  action.hint,
                  action.maxRetries,
                )
                  .then((r) => {
                    step.aiPrompt = r.prompt;
                    step.aiResponse = r.response;
                    if (r.retries.length) step.aiRetries = r.retries;
                    return r;
                  })
                  .finally(() => {
                    step.aiDurationMs = Date.now() - aiStart;
                  });

                // Clicks one button by exact text against the current message, refreshing the
                // markup on retry, and advances buttonsMsg to the reply so the next click sees
                // the updated markup. Throws if the button never clicks (aborts the action).
                const clickTarget = async (
                  targetText: string,
                ): Promise<{ clickedText: string; responseText: string }> => {
                  let clicked = false;
                  let retryCount = 0;
                  let clickedText = "";
                  let responseText = "";

                  const markupHasTarget = (m: Api.Message | null): boolean =>
                    hasInlineButtons(m) &&
                    (
                      (m as any).replyMarkup as Api.ReplyInlineMarkup
                    ).rows.some((row) =>
                      row.buttons.some(
                        (b: any) => ((b.text as string) ?? "") === targetText,
                      ),
                    );

                  for (
                    let attempt = 0;
                    attempt <= action.maxRetries && !clicked;
                    attempt++
                  ) {
                    if (attempt > 0) {
                      retryCount = attempt;
                      const fresh = await refetch(buttonsMsg!.id);
                      if (hasInlineButtons(fresh)) {
                        buttonsMsg = fresh;
                        if (botMode) lastButtonsMsg = fresh;
                      }
                      if (!markupHasTarget(buttonsMsg)) {
                        const msgs = await waitButtons(buttonsMsg?.id).catch(
                          () => null,
                        );
                        if (msgs) {
                          if (botMode) lastMessages = msgs;
                          const bm = [...msgs]
                            .reverse()
                            .find((m) => hasInlineButtons(m));
                          if (bm) {
                            buttonsMsg = bm;
                            if (botMode) lastButtonsMsg = bm;
                          }
                        }
                      }
                    }

                    const rows = (
                      (buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup
                    ).rows;
                    for (const row of rows) {
                      for (const btn of row.buttons) {
                        const btnText = (btn as any).text as string;
                        if (btnText !== targetText) continue;

                        const clickAbort = new AbortController();
                        const forwardAbort = () => clickAbort.abort();
                        signal?.addEventListener("abort", forwardAbort, {
                          once: true,
                        });

                        const editPromise = waitForBotMessageEdit(
                          client,
                          buttonsMsg!.id,
                          10_000,
                          clickAbort.signal,
                          editPeerId,
                        );
                        const newMsgPromise = waitNewMsg(10_000);

                        const callbackData = (btn as Api.KeyboardButtonCallback)
                          .data;
                        const preClickEditDate = (buttonsMsg as any).editDate as
                          | number
                          | undefined;
                        let answer: Api.messages.BotCallbackAnswer | null = null;
                        let callbackTimedOut = false;
                        try {
                          answer = (await client.invoke(
                            new Api.messages.GetBotCallbackAnswer({
                              peer,
                              msgId: buttonsMsg!.id,
                              data: callbackData,
                            }),
                          )) as Api.messages.BotCallbackAnswer;
                        } catch (err: any) {
                          if (
                            !err?.message?.includes("BOT_RESPONSE_TIMEOUT")
                          ) {
                            clickAbort.abort();
                            signal?.removeEventListener("abort", forwardAbort);
                            throw err;
                          }
                          callbackTimedOut = true;
                        }

                        if (answer?.message)
                          step.callbackAnswer = answer.message;
                        clicked = true;
                        step.retryCount = retryCount;

                        const taggedEdit = editPromise.then((m) => ({
                          msg: m,
                          src: "edit" as const,
                        }));
                        const taggedNew = newMsgPromise.then((m) => ({
                          msg: m,
                          src: "new_message" as const,
                        }));
                        const first = await Promise.race([
                          taggedEdit,
                          taggedNew,
                        ]);
                        let second:
                          | {
                              msg: Api.Message | null;
                              src: "edit" | "new_message";
                            }
                          | null = null;
                        if (first.msg && !hasInlineButtons(first.msg)) {
                          const other =
                            first.src === "edit" ? taggedNew : taggedEdit;
                          second = await Promise.race([
                            other,
                            new Promise<null>((r) =>
                              setTimeout(() => r(null), 1_500),
                            ),
                          ]);
                        }
                        clickAbort.abort();
                        signal?.removeEventListener("abort", forwardAbort);

                        const responses = [first, second].filter(
                          (
                            r,
                          ): r is {
                            msg: Api.Message;
                            src: "edit" | "new_message";
                          } => !!r?.msg && !signal?.aborted,
                        );
                        if (responses.length) {
                          const primary =
                            responses.find((r) => hasInlineButtons(r.msg)) ??
                            responses[0];
                          step.responseSource = primary.src;
                          if (hasInlineButtons(primary.msg)) {
                            buttonsMsg = primary.msg;
                            if (botMode) lastButtonsMsg = primary.msg;
                          }
                          if (botMode)
                            lastMessages = responses.map((r) => r.msg);
                          const parsed = await parseMessages(
                            responses.map((r) => r.msg),
                            client,
                            signal,
                          );
                          step.responseHtml = parsed.html || undefined;
                          step.responseImage = parsed.images[0];
                          step.responseHasMedia = parsed.hasMedia || undefined;
                          step.responseButtons = parsed.buttons.length
                            ? parsed.buttons
                            : undefined;
                        }

                        if (callbackTimedOut && !responses.length) {
                          const fresh = await refetch(buttonsMsg!.id);
                          const freshEditDate = (fresh as any)?.editDate as
                            | number
                            | undefined;
                          const wasEdited =
                            !!fresh &&
                            !!freshEditDate &&
                            freshEditDate !== preClickEditDate;
                          if (!wasEdited)
                            throw new Error(
                              `Button "${btnText}" click timed out (BOT_RESPONSE_TIMEOUT) with no response`,
                            );
                          step.responseSource = "edit";
                          if (hasInlineButtons(fresh)) {
                            buttonsMsg = fresh;
                            if (botMode) lastButtonsMsg = fresh;
                          }
                          if (botMode) lastMessages = [fresh!];
                          const parsed = await parseMessages(
                            [fresh!],
                            client,
                            signal,
                          );
                          step.responseHtml = parsed.html || undefined;
                          step.responseImage = parsed.images[0];
                          step.responseHasMedia = parsed.hasMedia || undefined;
                          step.responseButtons = parsed.buttons.length
                            ? parsed.buttons
                            : undefined;
                        }

                        // Success/fail text is judged by the caller: the success indicator
                        // typically only appears after the whole sequence is clicked.
                        responseText = [
                          answer?.message ?? "",
                          ...responses.map((r) => r.msg.message ?? ""),
                        ]
                          .filter(Boolean)
                          .join("\n");

                        clickedText = btnText;
                        step.clickedButton = btnText;
                        break;
                      }
                      if (clicked) break;
                    }
                  }

                  if (!clicked)
                    throw new Error(
                      `Button "${targetText}" not found after ${action.maxRetries + 1} attempt(s)`,
                    );
                  return { clickedText, responseText };
                };

                // ── Click each selected button in order, gap between clicks ──
                const clickedButtons: string[] = [];
                step.clickedButtons = clickedButtons;
                for (let k = 0; k < aiResult.buttons.length; k++) {
                  if (k > 0 && action.gapMs > 0) {
                    await new Promise<void>((res, rej) => {
                      if (signal?.aborted) {
                        rej(new Error("Job cancelled"));
                        return;
                      }
                      const timer = setTimeout(res, action.gapMs);
                      signal?.addEventListener(
                        "abort",
                        () => {
                          clearTimeout(timer);
                          rej(new Error("Job cancelled"));
                        },
                        { once: true },
                      );
                    });
                  }
                  const { clickedText, responseText } = await clickTarget(
                    aiResult.buttons[k],
                  );
                  clickedButtons.push(clickedText);

                  // failContains aborts as soon as any reply signals failure; successContains
                  // is only required on the final reply, since bots usually confirm success
                  // once the whole sequence is done.
                  if (
                    action.failContains &&
                    responseText.includes(action.failContains)
                  ) {
                    throw new Error(
                      `Reply indicates failure: "${action.failContains}" detected`,
                    );
                  }
                  const isLast = k === aiResult.buttons.length - 1;
                  if (
                    isLast &&
                    action.successContains &&
                    !responseText.includes(action.successContains)
                  ) {
                    throw new Error(
                      `Expected success indicator "${action.successContains}" not found in response`,
                    );
                  }
                }

                step.result = `Clicked ${clickedButtons.length} button(s): ${clickedButtons
                  .map((b) => `"${b}"`)
                  .join(", ")}`;
                break;
              }

              case "join_group": {
                const raw = action.groupId.trim();
                step.label = `Join group: ${raw}`;

                // Detect invite link: https://t.me/+HASH or https://t.me/joinchat/HASH
                const inviteMatch = raw.match(/(?:t\.me\/(?:joinchat\/|\+))([A-Za-z0-9_-]+)/);
                if (inviteMatch) {
                  const hash = inviteMatch[1];

                  if (action.checkMembership) {
                    // CheckChatInvite returns ChatInviteAlready when the user is already a member
                    const check = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
                    if (check instanceof Api.ChatInviteAlready || check instanceof Api.ChatInvitePeek) {
                      step.result = "Already a member (verified)";
                      break;
                    }
                  }

                  let pendingApproval = false;
                  try {
                    await client.invoke(new Api.messages.ImportChatInvite({ hash }));
                    step.result = "Joined via invite link";
                  } catch (err: any) {
                    if (err?.message?.includes("ALREADY_PARTICIPANT")) {
                      step.result = "Already a member";
                    } else if (err?.message?.includes("INVITE_REQUEST_SENT")) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    } else {
                      throw err;
                    }
                  }

                  if (action.checkMembership && !pendingApproval) {
                    const check = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
                    if (!(check instanceof Api.ChatInviteAlready || check instanceof Api.ChatInvitePeek)) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    }
                  }

                  if (pendingApproval && action.checkMembership)
                    throw new Error("Join not confirmed: request is still pending approval");
                } else {
                  // Public username: strip leading @
                  const username = raw.replace(/^@/, "");
                  const entity = await client.getEntity(username);

                  if (action.checkMembership && entity instanceof Api.Channel) {
                    if (await isChannelMember(client, entity)) {
                      step.result = "Already a member (verified)";
                      break;
                    }
                  }

                  let pendingApproval = false;
                  let freshlyJoined = false;
                  // Small tolerance for clock skew against Telegram server time
                  const joinStartSec = Math.floor(Date.now() / 1000) - 10;
                  try {
                    await client.invoke(new Api.channels.JoinChannel({ channel: entity as any }));
                    step.result = "Joined";
                    freshlyJoined = true;
                  } catch (err: any) {
                    if (err?.message?.includes("ALREADY_PARTICIPANT")) {
                      step.result = "Already a member";
                    } else if (err?.message?.includes("INVITE_REQUEST_SENT")) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    } else {
                      throw err;
                    }
                  }

                  if (action.checkMembership && !pendingApproval && entity instanceof Api.Channel) {
                    if (!(await isChannelMember(client, entity))) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    }
                  }

                  if (pendingApproval && action.checkMembership)
                    throw new Error("Join not confirmed: request is still pending approval");

                  // Only wait for the in-group verification prompt on a genuine fresh join --
                  // an already-joined account won't get a new prompt, so don't stall on it.
                  if (action.verifyButton && freshlyJoined && entity instanceof Api.Channel) {
                    await clickGroupVerification(
                      client,
                      entity,
                      action.verifyButton,
                      action.verifyWaitMs ?? 30000,
                      step,
                      signal,
                      joinStartSec,
                    );
                  }
                }
                break;
              }

              case "subscribe_channel": {
                const raw = action.channelId.trim();
                step.label = `Subscribe to channel: ${raw}`;

                // Detect invite link: https://t.me/+HASH or https://t.me/joinchat/HASH
                const inviteMatch = raw.match(/(?:t\.me\/(?:joinchat\/|\+))([A-Za-z0-9_-]+)/);
                if (inviteMatch) {
                  const hash = inviteMatch[1];

                  if (action.checkMembership) {
                    // CheckChatInvite returns ChatInviteAlready when the user is already subscribed
                    const check = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
                    if (check instanceof Api.ChatInviteAlready || check instanceof Api.ChatInvitePeek) {
                      step.result = "Already subscribed (verified)";
                      break;
                    }
                  }

                  let pendingApproval = false;
                  try {
                    await client.invoke(new Api.messages.ImportChatInvite({ hash }));
                    step.result = "Subscribed via invite link";
                  } catch (err: any) {
                    if (err?.message?.includes("ALREADY_PARTICIPANT")) {
                      step.result = "Already subscribed";
                    } else if (err?.message?.includes("INVITE_REQUEST_SENT")) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    } else {
                      throw err;
                    }
                  }

                  if (action.checkMembership && !pendingApproval) {
                    const check = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
                    if (!(check instanceof Api.ChatInviteAlready || check instanceof Api.ChatInvitePeek)) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    }
                  }

                  if (pendingApproval && action.checkMembership)
                    throw new Error("Subscription not confirmed: request is still pending approval");
                } else {
                  // Public username: strip leading @
                  const username = raw.replace(/^@/, "");
                  const entity = await client.getEntity(username);

                  if (action.checkMembership && entity instanceof Api.Channel) {
                    if (await isChannelMember(client, entity)) {
                      step.result = "Already subscribed (verified)";
                      break;
                    }
                  }

                  let pendingApproval = false;
                  try {
                    await client.invoke(new Api.channels.JoinChannel({ channel: entity as any }));
                    step.result = "Subscribed";
                  } catch (err: any) {
                    if (err?.message?.includes("ALREADY_PARTICIPANT")) {
                      step.result = "Already subscribed";
                    } else if (err?.message?.includes("INVITE_REQUEST_SENT")) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    } else {
                      throw err;
                    }
                  }

                  if (action.checkMembership && !pendingApproval && entity instanceof Api.Channel) {
                    if (!(await isChannelMember(client, entity))) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    }
                  }

                  if (pendingApproval && action.checkMembership)
                    throw new Error("Subscription not confirmed: request is still pending approval");
                }
                break;
              }
            }

            actionSucceeded = true;
          } catch (err: any) {
            // Cancellation is never retried
            if (err?.message === "Job cancelled") throw err;

            step.error = err?.message ?? String(err);
            step.errorName = err?.name ?? err?.constructor?.name;
            if (Array.isArray(err?.aiRetries) && err.aiRetries.length)
              step.aiRetries = err.aiRetries;
            if (err?.aiPrompt != null && step.aiPrompt == null)
              step.aiPrompt = err.aiPrompt;
            if (err?.aiResponse != null && step.aiResponse == null)
              step.aiResponse = err.aiResponse;

            if (actionAttempt > actionMaxRetries) {
              // All action retries exhausted -- fail this job attempt
              jobAttemptFailed = true;
              lastJobError = err;
            }
          } finally {
            step.durationMs = Date.now() - t0;
          }
        }

        if (jobAttemptFailed) break;
      }

      if (!jobAttemptFailed) {
        lastJobError = null;
        break;
      }
    }

    if (lastJobError) throw lastJobError;
  } catch (err: any) {
    if (err?.message === "Job cancelled") throw err;
    throw new CustomJobError(err?.message ?? String(err), log);
  } finally {
    // destroy, not disconnect -- only destroy stops the GramJS ping loop (issue #14)
    try {
      await client.destroy();
    } catch {
      /* ignore */
    }
  }

  return log;
}
