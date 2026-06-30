import { TelegramClient, Api, Logger } from "telegram";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import { NewMessage, type NewMessageEvent } from "telegram/events";
import { db } from "../db/database";
import { parseTgProxy } from "../jobs/runner";
import type { TgDeviceParams } from "../auth/tgAuth";

export type TgLiveMessage = {
  chatId: string;
  message: TgMsgPayload;
};

export type TgReaction = {
  emoji: string;
  count: number;
  mine: boolean;
};

export type TgButton = {
  text: string;
  data: string | null; // base64-encoded callback data
  url: string | null;
  webApp: boolean; // Telegram Mini App button -- must open in a real browser
};

export type TgMsgPayload = {
  id: number;
  text: string;
  html: string | null; // safe HTML with entity markup; null = plain text
  date: number;
  fromMe: boolean;
  fromId: string | null;
  fromName: string | null;
  hasPhoto: boolean;
  hasDocument: boolean;
  buttons: TgButton[][] | null;
  reactions: TgReaction[] | null;
  replyToId: number | null;
  replyToText: string | null;
  replyToName: string | null;
  replyCount: number | null;
};

export type TgDialogItem = {
  chatId: string;
  name: string;
  type: "user" | "bot" | "group" | "channel";
  username: string | null;
  unreadCount: number;
  lastMessage: { text: string; date: number; fromMe: boolean } | null;
  left?: boolean; // true when the current user is not a member (search/resolve results)
};

export type TgContactItem = {
  chatId: string;
  firstName: string;
  lastName: string;
  username: string | null;
  phone: string | null;
};

type LiveEntry = {
  client: TelegramClient;
  entityCache: Map<string, Api.User | Api.Chat | Api.Channel>;
  subscribers: Set<(msg: TgLiveMessage) => void>;
  dialogSubscribers: Set<(dialogs: TgDialogItem[]) => void>;
  // Per-entry avatar cache: chatId -> Buffer (has avatar) | null (no avatar) | undefined (not fetched)
  avatarCache: Map<string, Buffer | null>;
};

const liveClients = new Map<number, LiveEntry>();

type AccountRow = {
  api_id: number;
  api_hash: string;
  session_string: string | null;
  proxy_id: string | null;
  app_client_id: string | null;
};

// Derive a stable chatId string from an entity
export function entityToChatId(
  entity: Api.User | Api.Chat | Api.Channel,
): string {
  const id = entity.id.toString();
  if (entity instanceof Api.User) return `u${id}`;
  if (entity instanceof Api.Channel) return `c${id}`;
  return `g${id}`;
}

// Build chatId from a peer reference
export function peerToChatId(peer: Api.TypePeer): string {
  if (peer instanceof Api.PeerUser) return `u${peer.userId.toString()}`;
  if (peer instanceof Api.PeerChannel) return `c${peer.channelId.toString()}`;
  if (peer instanceof Api.PeerChat) return `g${peer.chatId.toString()}`;
  return "";
}

// Reverse of peerToChatId -- used as a fallback entity lookup key
function chatIdToPeer(chatId: string): Api.TypePeer | null {
  try {
    if (chatId.startsWith('u')) return new Api.PeerUser({ userId: BigInt(chatId.slice(1)) as any });
    if (chatId.startsWith('c')) return new Api.PeerChannel({ channelId: BigInt(chatId.slice(1)) as any });
    if (chatId.startsWith('g')) return new Api.PeerChat({ chatId: BigInt(chatId.slice(1)) as any });
  } catch { /* ignore malformed ids */ }
  return null;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Only allow http/https/tg URLs in href attributes -- strips anything else.
function safeHref(url: string): string {
  try {
    return /^(https?|tg):$/i.test(new URL(url).protocol) ? url : "";
  } catch {
    return "";
  }
}

// Converts Telegram message entities to safe HTML. Returns null when there are
// no formatting entities (plain text can be rendered directly).
function entitiesToHtml(
  text: string,
  entities: Api.TypeMessageEntity[] | undefined,
): string | null {
  if (!entities?.length) return null;

  type Span = { offset: number; end: number; open: string; close: string };
  const spans: Span[] = [];

  for (const e of entities) {
    const end = e.offset + e.length;
    if (e instanceof Api.MessageEntityTextUrl) {
      const safe = safeHref(e.url ?? "");
      if (safe) {
        spans.push({
          offset: e.offset,
          end,
          open: `<a href="${escHtml(safe)}" class="tgc-link" data-tgurl>`,
          close: "</a>",
        });
      }
    } else if (e instanceof Api.MessageEntityUrl) {
      const url = text.slice(e.offset, end);
      const safe = safeHref(url);
      if (safe) {
        spans.push({
          offset: e.offset,
          end,
          open: `<a href="${escHtml(safe)}" class="tgc-link" data-tgurl>`,
          close: "</a>",
        });
      }
    } else if (e instanceof Api.MessageEntityMention) {
      const handle = text.slice(e.offset + 1, end); // strip leading @
      spans.push({
        offset: e.offset,
        end,
        open: `<a href="https://t.me/${escHtml(handle)}" class="tgc-link" data-tgurl>`,
        close: "</a>",
      });
    } else if (e instanceof Api.MessageEntityBold) {
      spans.push({
        offset: e.offset,
        end,
        open: "<strong>",
        close: "</strong>",
      });
    } else if (e instanceof Api.MessageEntityItalic) {
      spans.push({ offset: e.offset, end, open: "<em>", close: "</em>" });
    } else if (e instanceof Api.MessageEntityUnderline) {
      spans.push({ offset: e.offset, end, open: "<u>", close: "</u>" });
    } else if (e instanceof Api.MessageEntityStrike) {
      spans.push({ offset: e.offset, end, open: "<s>", close: "</s>" });
    } else if (e instanceof Api.MessageEntityCode) {
      spans.push({ offset: e.offset, end, open: "<code>", close: "</code>" });
    } else if (e instanceof Api.MessageEntityPre) {
      spans.push({ offset: e.offset, end, open: "<pre>", close: "</pre>" });
    }
  }

  if (!spans.length) return null;

  // Sort by offset ascending; longer spans first at same offset
  spans.sort((a, b) => a.offset - b.offset || b.end - a.end);

  let html = "";
  let pos = 0;
  for (const span of spans) {
    if (span.offset < pos) continue; // skip overlapping spans
    if (span.offset > pos)
      html += escHtml(text.slice(pos, span.offset)).replace(/\n/g, "<br>");
    html += span.open + escHtml(text.slice(span.offset, span.end)) + span.close;
    pos = span.end;
  }
  if (pos < text.length)
    html += escHtml(text.slice(pos)).replace(/\n/g, "<br>");
  return html;
}

function entityName(entity: Api.User | Api.Chat | Api.Channel): string {
  if (entity instanceof Api.User) {
    return (
      [entity.firstName, entity.lastName].filter(Boolean).join(" ") ||
      entity.username ||
      "Unknown"
    );
  }
  return (entity as any).title ?? (entity as any).username ?? "Unknown";
}

function extractButtons(msg: Api.Message): TgButton[][] | null {
  if (!msg.replyMarkup) return null;
  if (msg.replyMarkup instanceof Api.ReplyInlineMarkup) {
    return msg.replyMarkup.rows.map((row) =>
      row.buttons.map(
        (btn: any): TgButton => ({
          text: btn.text ?? "",
          data: btn.data ? Buffer.from(btn.data).toString("base64") : null,
          url: btn.url ?? null,
          webApp:
            btn instanceof Api.KeyboardButtonWebView ||
            btn instanceof Api.KeyboardButtonSimpleWebView,
        }),
      ),
    );
  }
  return null;
}

function extractReactions(msg: Api.Message): TgReaction[] | null {
  const r = (msg as any).reactions;
  if (!r?.results?.length) return null;
  const out = (r.results as any[])
    .filter((rc: any) => rc.reaction?.emoticon)
    .map((rc: any) => ({
      emoji: rc.reaction.emoticon as string,
      count: rc.count as number,
      mine: rc.chosenOrder !== undefined && rc.chosenOrder !== null,
    }));
  return out.length ? out : null;
}

function resolveProxy(proxyId: string | null) {
  if (!proxyId) return undefined;
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("proxies") as { value: string } | undefined;
    if (!row?.value) return undefined;
    const list: Array<{ id: string; url: string }> = JSON.parse(row.value);
    return parseTgProxy(list.find((p) => p.id === proxyId)?.url);
  } catch {
    return undefined;
  }
}

function resolveDeviceParams(
  appClientId: string | null,
): TgDeviceParams | undefined {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("tg_app_clients") as { value: string } | undefined;
    if (!row?.value) return undefined;
    const list: Array<{ id: string; isDefault?: boolean } & TgDeviceParams> =
      JSON.parse(row.value);
    const c = appClientId
      ? list.find((x) => x.id === appClientId)
      : list.find((x) => x.isDefault);
    if (!c) return undefined;
    return {
      deviceModel: c.deviceModel,
      systemVersion: c.systemVersion,
      appVersion: c.appVersion,
      langCode: c.langCode,
      langPack: c.langPack,
      systemLangCode: c.systemLangCode,
    };
  } catch {
    return undefined;
  }
}

export async function reconnectClient(accountId: number): Promise<void> {
  const entry = liveClients.get(accountId);
  if (entry) {
    try {
      await entry.client.disconnect();
    } catch {
      /* ignore */
    }
    liveClients.delete(accountId);
  }
  await getLiveClient(accountId);
}

const AUTH_ERROR_CODES = [
  "AUTH_KEY_DUPLICATED",
  "AUTH_KEY_INVALID",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN",
];

export function isAuthError(msg: string): boolean {
  return AUTH_ERROR_CODES.some((code) => msg.includes(code));
}

export function markSessionExpired(accountId: number): void {
  db.prepare(
    "UPDATE tg_accounts SET auth_status = 'session_expired' WHERE id = ?",
  ).run(accountId);
  const entry = liveClients.get(accountId);
  if (entry) {
    entry.client.disconnect().catch(() => {});
    liveClients.delete(accountId);
  }
}

export async function getLiveClient(accountId: number): Promise<LiveEntry> {
  let entry = liveClients.get(accountId);
  if (entry) {
    if (!entry.client.connected) await entry.client.connect();
    return entry;
  }

  const account = db
    .prepare(
      "SELECT api_id, api_hash, session_string, proxy_id, app_client_id FROM tg_accounts WHERE id = ?",
    )
    .get(accountId) as AccountRow | undefined;

  if (!account?.session_string)
    throw new Error("Account not found or not authenticated");

  const proxy = resolveProxy(account.proxy_id);
  const deviceParams = resolveDeviceParams(account.app_client_id);

  const client = new TelegramClient(
    new StringSession(account.session_string),
    account.api_id,
    account.api_hash,
    {
      connectionRetries: 5,
      baseLogger: new Logger(LogLevel.NONE),
      ...(proxy ? { proxy } : {}),
      ...(deviceParams ?? {}),
    },
  );

  try {
    await client.connect();
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) {
      db.prepare(
        "UPDATE tg_accounts SET auth_status = 'session_expired' WHERE id = ?",
      ).run(accountId);
    }
    throw err;
  }

  // Invoke GetState so Telegram knows this session is active and starts pushing updates.
  // Fire-and-forget -- we don't want to block the first HTTP request.
  client.invoke(new Api.updates.GetState()).catch(() => {});

  entry = {
    client,
    entityCache: new Map(),
    subscribers: new Set(),
    dialogSubscribers: new Set(),
    avatarCache: new Map(),
  };
  liveClients.set(accountId, entry);

  client.addEventHandler((event: NewMessageEvent) => {
    const msg = event.message as Api.Message;
    if (!msg?.peerId) return;

    const chatId = peerToChatId(msg.peerId);
    if (!chatId) return;

    let fromName: string | null = null;
    if (msg.fromId) {
      const fid = peerToChatId(msg.fromId as Api.TypePeer);
      const sender = entry!.entityCache.get(fid);
      if (sender) fromName = entityName(sender);
    }

    const liveMsg: TgLiveMessage = {
      chatId,
      message: {
        id: msg.id,
        text: msg.message ?? "",
        html: entitiesToHtml(msg.message ?? "", msg.entities),
        date: msg.date,
        fromMe: Boolean(msg.out),
        fromId: msg.fromId ? peerToChatId(msg.fromId as Api.TypePeer) : null,
        fromName,
        hasPhoto: msg.media instanceof Api.MessageMediaPhoto,
        hasDocument: msg.media instanceof Api.MessageMediaDocument,
        buttons: extractButtons(msg),
        reactions: extractReactions(msg),
        replyToId: (msg.replyTo as any)?.replyToMsgId ?? null,
        replyToText: null,
        replyToName: null,
        replyCount: (msg as any).replies?.replies ?? null,
      },
    };

    cacheMessages(accountId, chatId, [liveMsg.message]);
    entry!.subscribers.forEach((sub) => sub(liveMsg));
  }, new NewMessage({}));

  return entry;
}

// Load all dialogs into the entity cache
export async function loadDialogs(
  entry: LiveEntry,
  limit = 200,
): Promise<TgDialogItem[]> {
  const dialogs = await entry.client.getDialogs({ limit });
  const result: TgDialogItem[] = [];

  for (const d of dialogs) {
    if (!d.entity) continue;
    const entity = d.entity as Api.User | Api.Chat | Api.Channel;
    const chatId = entityToChatId(entity);
    entry.entityCache.set(chatId, entity);

    const type: TgDialogItem["type"] =
      entity instanceof Api.User
        ? entity.bot
          ? "bot"
          : "user"
        : entity instanceof Api.Channel
          ? entity.megagroup
            ? "group"
            : "channel"
          : "group";

    const lastMsg = d.message as Api.Message | undefined;
    result.push({
      chatId,
      name: d.name ?? entityName(entity),
      type,
      username: (entity as any).username ?? null,
      unreadCount: d.dialog.unreadCount ?? 0,
      lastMessage: lastMsg
        ? {
            text: lastMsg.message ?? "",
            date: lastMsg.date,
            fromMe: Boolean(lastMsg.out),
          }
        : null,
    });
  }

  return result;
}

export async function ensureEntityCached(
  entry: LiveEntry,
  chatId: string,
): Promise<void> {
  if (entry.entityCache.has(chatId)) return;
  await loadDialogs(entry);
  if (entry.entityCache.has(chatId)) return;
  // Fallback for group members not in the user's dialogs (e.g. other participants).
  // GramJS keeps these in its internal session store after messages are fetched,
  // so getEntity resolves them without an extra network round-trip in most cases.
  try {
    const peer = chatIdToPeer(chatId);
    if (peer) {
      const entity = await entry.client.getEntity(peer) as Api.User | Api.Chat | Api.Channel;
      if (entity) entry.entityCache.set(chatId, entity);
    }
  } catch { /* not resolvable -- fetchAvatar will cache null and won't retry */ }
}

export async function getMessages(
  entry: LiveEntry,
  chatId: string,
  limit: number,
  offsetId: number,
): Promise<TgMsgPayload[]> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found -- open the dialogs list first");

  const all = await entry.client.getMessages(entity, {
    limit,
    ...(offsetId ? { offsetId } : {}),
  });
  // Drop service messages (join/leave/pin announcements) and empty placeholders
  const msgs = all.filter((m) => m instanceof Api.Message);

  // Batch-fetch reply-to message texts for quote display
  const replyIdSet = new Set<number>();
  for (const msg of msgs) {
    const rt = (msg as any).replyTo;
    if (rt?.className === "MessageReplyHeader" && rt.replyToMsgId) {
      replyIdSet.add(rt.replyToMsgId as number);
    }
  }
  const replyMap = new Map<number, { text: string; name: string | null }>();
  if (replyIdSet.size > 0) {
    try {
      const replyMsgs = await entry.client.getMessages(entity, {
        ids: [...replyIdSet],
      });
      for (const rm of replyMsgs) {
        if (!rm?.id) continue;
        let rname: string | null = null;
        if (rm.fromId) {
          const rfid = peerToChatId(rm.fromId as Api.TypePeer);
          const rsender = entry.entityCache.get(rfid);
          if (rsender) rname = entityName(rsender);
        }
        replyMap.set(rm.id, { text: rm.message ?? "", name: rname });
      }
    } catch {
      // Best effort -- reply quotes may be missing
    }
  }

  return msgs.map((msg) => {
    let fromName: string | null = null;
    if (msg.fromId) {
      const fid = peerToChatId(msg.fromId as Api.TypePeer);
      const sender = entry.entityCache.get(fid);
      if (sender) fromName = entityName(sender);
    }
    const rt = (msg as any).replyTo;
    const replyToId =
      rt?.className === "MessageReplyHeader" ? (rt.replyToMsgId ?? null) : null;
    const replyInfo = replyToId ? replyMap.get(replyToId) : undefined;
    return {
      id: msg.id,
      text: msg.message ?? "",
      html: entitiesToHtml(msg.message ?? "", (msg as Api.Message).entities),
      date: msg.date,
      fromMe: Boolean(msg.out),
      fromId: msg.fromId ? peerToChatId(msg.fromId as Api.TypePeer) : null,
      fromName,
      hasPhoto: msg.media instanceof Api.MessageMediaPhoto,
      hasDocument: msg.media instanceof Api.MessageMediaDocument,
      buttons: extractButtons(msg as Api.Message),
      reactions: extractReactions(msg as Api.Message),
      replyToId,
      replyToText: replyInfo?.text ?? null,
      replyToName: replyInfo?.name ?? null,
      replyCount: (msg as any).replies?.replies ?? null,
    };
  });
}

export async function getPinnedMessage(
  entry: LiveEntry,
  chatId: string,
): Promise<TgMsgPayload | null> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");

  let pinnedMsgId: number | null = null;

  if (entity instanceof Api.Channel) {
    const result = await entry.client.invoke(
      new Api.channels.GetFullChannel({ channel: entity as any }),
    );
    pinnedMsgId = (result.fullChat as any).pinnedMsgId ?? null;
  } else if (entity instanceof Api.Chat) {
    const result = await entry.client.invoke(
      new Api.messages.GetFullChat({ chatId: (entity as Api.Chat).id as any }),
    );
    pinnedMsgId = (result.fullChat as any).pinnedMsgId ?? null;
  }

  if (!pinnedMsgId) return null;

  const msgs = await entry.client.getMessages(entity, { ids: [pinnedMsgId] });
  if (!msgs.length || !msgs[0]) return null;

  const msg = msgs[0] as Api.Message;
  return {
    id: msg.id,
    text: msg.message ?? "",
    html: entitiesToHtml(msg.message ?? "", (msg as Api.Message).entities),
    date: msg.date,
    fromMe: Boolean(msg.out),
    fromId: msg.fromId ? peerToChatId(msg.fromId as Api.TypePeer) : null,
    fromName: null,
    hasPhoto: msg.media instanceof Api.MessageMediaPhoto,
    hasDocument: msg.media instanceof Api.MessageMediaDocument,
    buttons: extractButtons(msg),
    reactions: null,
    replyToId: null,
    replyToText: null,
    replyToName: null,
    replyCount: null,
  };
}

export async function sendMessage(
  entry: LiveEntry,
  chatId: string,
  text: string,
  replyToMsgId?: number,
): Promise<{ id: number; date: number }> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");

  const result = await entry.client.sendMessage(entity, {
    message: text,
    parseMode: undefined,
    ...(replyToMsgId ? { replyTo: replyToMsgId } : {}),
  });
  return { id: result.id, date: result.date };
}

export async function getContacts(entry: LiveEntry): Promise<TgContactItem[]> {
  const result = await entry.client.invoke(
    new Api.contacts.GetContacts({ hash: BigInt(0) as any }),
  );
  if (!("users" in result)) return [];

  return (result.users as Api.User[])
    .filter((u) => !u.deleted)
    .map((u) => {
      const chatId = entityToChatId(u);
      entry.entityCache.set(chatId, u);
      return {
        chatId,
        firstName: u.firstName ?? "",
        lastName: u.lastName ?? "",
        username: u.username ?? null,
        phone: u.phone ?? null,
      };
    });
}

export async function addContact(
  entry: LiveEntry,
  phone: string,
  firstName: string,
  lastName = "",
): Promise<TgContactItem | null> {
  const result = await entry.client.invoke(
    new Api.contacts.ImportContacts({
      contacts: [
        new Api.InputPhoneContact({
          clientId: BigInt(Date.now() % 1_000_000) as any,
          phone,
          firstName,
          lastName,
        }),
      ],
    }),
  );

  const user = (result.users as Api.User[])[0];
  if (!user) return null;

  const chatId = entityToChatId(user);
  entry.entityCache.set(chatId, user);
  return {
    chatId,
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? "",
    username: user.username ?? null,
    phone: user.phone ?? null,
  };
}

export async function searchPeers(
  entry: LiveEntry,
  query: string,
): Promise<TgDialogItem[]> {
  const result = await entry.client.invoke(
    new Api.contacts.Search({ q: query, limit: 20 }),
  );

  const items: TgDialogItem[] = [];

  for (const u of result.users as Api.User[]) {
    if (u.deleted) continue;
    const chatId = entityToChatId(u);
    entry.entityCache.set(chatId, u);
    items.push({
      chatId,
      name: entityName(u),
      type: u.bot ? "bot" : "user",
      username: u.username ?? null,
      unreadCount: 0,
      lastMessage: null,
    });
  }

  for (const c of result.chats as (Api.Chat | Api.Channel)[]) {
    if ((c as any).deactivated || (c as any).forbidden) continue;
    const chatId = entityToChatId(c as Api.Chat | Api.Channel);
    entry.entityCache.set(chatId, c as Api.Chat | Api.Channel);
    items.push({
      chatId,
      name: entityName(c as Api.Chat | Api.Channel),
      type:
        c instanceof Api.Channel
          ? c.megagroup
            ? "group"
            : "channel"
          : "group",
      username: (c as any).username ?? null,
      unreadCount: 0,
      lastMessage: null,
      left: c instanceof Api.Channel ? Boolean(c.left) : false,
    });
  }

  return items;
}

export async function fetchPhoto(
  entry: LiveEntry,
  chatId: string,
  msgId: number,
): Promise<Buffer | null> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) return null;

  const [msg] = await entry.client.getMessages(entity, { ids: [msgId] });
  if (!msg?.media) return null;

  const data = await entry.client.downloadMedia(msg, {});
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "binary");
  return Buffer.from(data as Uint8Array);
}

export async function fetchAvatar(
  entry: LiveEntry,
  chatId: string,
): Promise<Buffer | null> {
  if (entry.avatarCache.has(chatId)) return entry.avatarCache.get(chatId)!;
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) {
    entry.avatarCache.set(chatId, null);
    return null;
  }
  try {
    // isBig must be provided -- GramJS throws TypeError if fileParams is undefined
    const data = await entry.client.downloadProfilePhoto(
      entity as any,
      { isBig: false } as any,
    );
    if (!data || (Buffer.isBuffer(data) && data.length === 0)) {
      entry.avatarCache.set(chatId, null);
      return null;
    }
    const buf = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data as unknown as Uint8Array);
    entry.avatarCache.set(chatId, buf);
    return buf;
  } catch {
    entry.avatarCache.set(chatId, null);
    return null;
  }
}

// Fetch multiple avatars with bounded concurrency (10 at a time).
// Returns a map of chatId -> base64 jpeg string for chats that have an avatar.
export async function fetchAvatarsBatch(
  entry: LiveEntry,
  chatIds: string[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const CONCURRENCY = 10;
  for (let i = 0; i < chatIds.length; i += CONCURRENCY) {
    await Promise.all(
      chatIds.slice(i, i + CONCURRENCY).map(async (chatId) => {
        const buf = await fetchAvatar(entry, chatId);
        if (buf) result[chatId] = buf.toString("base64");
      }),
    );
  }
  return result;
}

export type TgProfileInfo = {
  chatId: string;
  name: string;
  type: "user" | "bot" | "group" | "channel";
  username: string | null;
  phone: string | null;
  bio: string | null;
  memberCount: number | null;
};

export async function getEntityDetails(
  entry: LiveEntry,
  chatId: string,
): Promise<TgProfileInfo> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Entity not found");

  const type: TgProfileInfo["type"] =
    entity instanceof Api.User
      ? (entity as any).bot
        ? "bot"
        : "user"
      : entity instanceof Api.Channel
        ? (entity as any).megagroup
          ? "group"
          : "channel"
        : "group";

  let bio: string | null = null;
  let memberCount: number | null = null;

  try {
    if (entity instanceof Api.User) {
      const full = await entry.client.invoke(
        new Api.users.GetFullUser({ id: entity as any }),
      );
      bio = (full as any).fullUser?.about ?? null;
    } else if (entity instanceof Api.Channel) {
      const full = await entry.client.invoke(
        new Api.channels.GetFullChannel({ channel: entity as any }),
      );
      bio = (full as any).fullChat?.about ?? null;
      memberCount = (full as any).fullChat?.participantsCount ?? null;
    } else {
      const full = await entry.client.invoke(
        new Api.messages.GetFullChat({ chatId: (entity as any).id as any }),
      );
      bio = (full as any).fullChat?.about ?? null;
      memberCount =
        (full as any).fullChat?.participants?.participants?.length ?? null;
    }
  } catch {
    // Full details unavailable -- basic info from entity cache is still returned
  }

  return {
    chatId,
    name: entityName(entity),
    type,
    username: (entity as any).username ?? null,
    phone: (entity as any).phone ?? null,
    bio,
    memberCount,
  };
}

export type TgFolderItem = {
  id: number;
  title: string;
  emoticon: string | null;
  includeGroups: boolean;
  includeBroadcasts: boolean;
  includeBots: boolean;
  includeContacts: boolean;
  includeNonContacts: boolean;
  pinnedChatIds: string[];
  includedChatIds: string[];
  excludedChatIds: string[];
};

// Convert an InputPeer (from DialogFilter peer lists) to chatId format
function inputPeerToChatId(peer: any): string {
  if (!peer) return "";
  if (peer.userId !== undefined) return `u${peer.userId}`;
  if (peer.channelId !== undefined) return `c${peer.channelId}`;
  if (peer.chatId !== undefined) return `g${peer.chatId}`;
  return "";
}

// Mute a dialog -- pass muteSecs=0 to unmute
export async function muteDialog(
  entry: LiveEntry,
  chatId: string,
  muteSecs: number,
): Promise<void> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Entity not found");

  let peer: any;
  if (entity instanceof Api.User) {
    peer = new Api.InputNotifyPeer({
      peer: new Api.InputPeerUser({
        userId: (entity as any).id,
        accessHash: (entity as any).accessHash ?? (BigInt(0) as any),
      }),
    });
  } else if (entity instanceof Api.Channel) {
    peer = new Api.InputNotifyPeer({
      peer: new Api.InputPeerChannel({
        channelId: (entity as any).id,
        accessHash: (entity as any).accessHash ?? (BigInt(0) as any),
      }),
    });
  } else {
    peer = new Api.InputNotifyPeer({
      peer: new Api.InputPeerChat({ chatId: (entity as any).id as any }),
    });
  }

  await entry.client.invoke(
    new Api.account.UpdateNotifySettings({
      peer,
      settings: new Api.InputPeerNotifySettings({
        muteUntil:
          muteSecs === 0 ? 0 : Math.floor(Date.now() / 1000) + muteSecs,
      }),
    }),
  );
}

// Pin or unpin a dialog in the user's dialog list
export async function pinDialog(
  entry: LiveEntry,
  chatId: string,
  pinned: boolean,
): Promise<void> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Entity not found");

  let peer: any;
  if (entity instanceof Api.User) {
    peer = new Api.InputDialogPeer({
      peer: new Api.InputPeerUser({
        userId: (entity as any).id,
        accessHash: (entity as any).accessHash ?? (BigInt(0) as any),
      }),
    });
  } else if (entity instanceof Api.Channel) {
    peer = new Api.InputDialogPeer({
      peer: new Api.InputPeerChannel({
        channelId: (entity as any).id,
        accessHash: (entity as any).accessHash ?? (BigInt(0) as any),
      }),
    });
  } else {
    peer = new Api.InputDialogPeer({
      peer: new Api.InputPeerChat({ chatId: (entity as any).id as any }),
    });
  }

  await entry.client.invoke(new Api.messages.ToggleDialogPin({ peer, pinned }));
}

export async function getFolders(entry: LiveEntry): Promise<TgFolderItem[]> {
  try {
    const raw = await entry.client.invoke(new Api.messages.GetDialogFilters());
    // Older layers return a plain array; newer layers wrap in { filters: [...] }
    const filters: any[] = Array.isArray(raw)
      ? raw
      : ((raw as any)?.filters ?? []);

    return filters
      .filter((f: any) => f.id && f.title !== undefined)
      .map((f: any) => ({
        id: f.id as number,
        title:
          typeof f.title === "string" ? f.title : (f.title?.text ?? "Folder"),
        emoticon: (f.emoticon as string | undefined) ?? null,
        includeGroups: Boolean(f.groups),
        includeBroadcasts: Boolean(f.broadcasts),
        includeBots: Boolean(f.bots),
        includeContacts: Boolean(f.contacts),
        includeNonContacts: Boolean(f.nonContacts),
        pinnedChatIds: ((f.pinnedPeers ?? []) as any[])
          .map(inputPeerToChatId)
          .filter(Boolean),
        includedChatIds: ((f.includePeers ?? []) as any[])
          .map(inputPeerToChatId)
          .filter(Boolean),
        excludedChatIds: ((f.excludePeers ?? []) as any[])
          .map(inputPeerToChatId)
          .filter(Boolean),
      }));
  } catch {
    return [];
  }
}

export type TgButtonResult = {
  alert: boolean;
  message: string | null;
  url: string | null;
};

export type TgInvitePreview = {
  hash: string;
  title: string;
  memberCount: number;
  type: "group" | "channel";
  alreadyJoined: boolean;
  chatId?: string;
};

export type TgBotCommand = {
  command: string;
  description: string;
};

export async function clickButton(
  entry: LiveEntry,
  chatId: string,
  msgId: number,
  data: string,
): Promise<TgButtonResult> {
  const { client } = entry;
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");
  const dataBytes = Buffer.from(data, "base64");
  console.log(`[button] chatId=${chatId} msgId=${msgId} data_hex=${dataBytes.toString("hex")} data_utf8=${dataBytes.toString("utf8")}`);
  const result = await client.invoke(
    new Api.messages.GetBotCallbackAnswer({
      peer: entity as any,
      msgId,
      data: dataBytes,
      game: false,
    }),
  );
  console.log(`[button] result alert=${result.alert} message=${JSON.stringify(result.message)} url=${result.url ?? "null"}`);
  return {
    alert: result.alert ?? false,
    message: result.message ?? null,
    url: result.url ?? null,
  };
}

export async function sendReaction(
  entry: LiveEntry,
  chatId: string,
  msgId: number,
  emoji: string | null,
): Promise<void> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");
  await entry.client.invoke(
    new Api.messages.SendReaction({
      peer: entity as any,
      msgId,
      reaction: emoji ? [new Api.ReactionEmoji({ emoticon: emoji })] : [],
    }),
  );
}

export async function getThreadMessages(
  entry: LiveEntry,
  chatId: string,
  msgId: number,
  limit: number,
  offsetId: number,
): Promise<TgMsgPayload[]> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");

  const result = await entry.client.invoke(
    new Api.messages.GetReplies({
      peer: entity as any,
      msgId,
      offsetId,
      offsetDate: 0,
      addOffset: 0,
      limit,
      maxId: 0,
      minId: 0,
      hash: BigInt(0) as any,
    }),
  );

  const msgs = ((result as any).messages ?? []) as Api.Message[];
  return msgs.map((msg) => {
    let fromName: string | null = null;
    if (msg.fromId) {
      const fid = peerToChatId(msg.fromId as Api.TypePeer);
      const sender = entry.entityCache.get(fid);
      if (sender) fromName = entityName(sender);
    }
    return {
      id: msg.id,
      text: msg.message ?? "",
      html: entitiesToHtml(msg.message ?? "", msg.entities),
      date: msg.date,
      fromMe: Boolean(msg.out),
      fromId: msg.fromId ? peerToChatId(msg.fromId as Api.TypePeer) : null,
      fromName,
      hasPhoto: msg.media instanceof Api.MessageMediaPhoto,
      hasDocument: msg.media instanceof Api.MessageMediaDocument,
      buttons: extractButtons(msg),
      reactions: extractReactions(msg),
      replyToId: null,
      replyToText: null,
      replyToName: null,
      replyCount: null,
    };
  });
}

export async function getBotCommands(
  entry: LiveEntry,
  chatId: string,
): Promise<TgBotCommand[]> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!(entity instanceof Api.User) || !entity.bot) return [];
  try {
    // GetFullUser returns botInfo.commands for bot entities
    const full = await entry.client.invoke(
      new Api.users.GetFullUser({ id: entity as any }),
    );
    const commands: any[] = (full as any).fullUser?.botInfo?.commands ?? [];
    return commands.map((c: any) => ({
      command: c.command as string,
      description: c.description as string,
    }));
  } catch {
    return [];
  }
}

export async function resolvePeer(
  entry: LiveEntry,
  username: string,
): Promise<TgDialogItem | null> {
  const query = username.startsWith("@") ? username : `@${username}`;
  try {
    const entity = await entry.client.getEntity(query);
    if (!entity) return null;
    let chatId: string;
    let type: TgDialogItem["type"];
    let name: string;
    let uname: string | null = null;
    if (entity instanceof Api.User) {
      chatId = `u${entity.id}`;
      type = entity.bot ? "bot" : "user";
      name =
        [entity.firstName, entity.lastName].filter(Boolean).join(" ") || query;
      uname = entity.username ?? null;
    } else if (entity instanceof Api.Channel) {
      chatId = `c${entity.id}`;
      type = entity.megagroup ? "group" : "channel";
      name = entity.title ?? query;
      uname = entity.username ?? null;
    } else if (entity instanceof Api.Chat) {
      chatId = `g${(entity as Api.Chat).id}`;
      type = "group";
      name = (entity as Api.Chat).title ?? query;
    } else {
      return null;
    }
    entry.entityCache.set(chatId, entity as Api.User | Api.Chat | Api.Channel);
    const left = entity instanceof Api.Channel ? Boolean(entity.left) : false;
    return {
      chatId,
      name,
      type,
      username: uname,
      unreadCount: 0,
      lastMessage: null,
      left,
    };
  } catch {
    return null;
  }
}

export type JoinResult = { joined: true } | { requestSent: true };

// Opens a bot chat and sends the startParam via messages.StartBot (mirrors clicking a t.me/bot?start=PARAM link).
export async function startBot(
  entry: LiveEntry,
  username: string,
  startParam: string,
): Promise<TgDialogItem> {
  const query = username.startsWith("@") ? username : `@${username}`;
  const entity = await entry.client.getEntity(query);
  if (!(entity instanceof Api.User) || !entity.bot) {
    throw new Error("Not a bot");
  }
  const chatId = `u${entity.id}`;
  entry.entityCache.set(chatId, entity);

  await entry.client.invoke(
    new Api.messages.StartBot({
      bot: entity as any,
      peer: entity as any,
      randomId: BigInt(Date.now() % 1_000_000_000) as any,
      startParam,
    }),
  );

  const name = [entity.firstName, entity.lastName].filter(Boolean).join(" ") || username;
  return {
    chatId,
    name,
    type: "bot",
    username: entity.username ?? null,
    unreadCount: 0,
    lastMessage: null,
  };
}

// Resolves a mini app URL to an authenticated web app URL.
// Handles two cases:
//   - t.me/BotName?startapp=HASH  -- uses RequestWebView with the start param
//   - Direct web app URL from a KeyboardButtonWebView -- uses RequestSimpleWebView
export async function resolveWebApp(
  entry: LiveEntry,
  tmeOrUrl: string,
  botChatId?: string, // for direct URLs we need to know which bot owns the app
): Promise<string> {
  // t.me/BotName?startapp=HASH pattern
  const startappM = tmeOrUrl.match(
    /t(?:elegram)?\.me\/([A-Za-z]\w+)\?startapp=([^&\s]+)/i,
  );
  if (startappM) {
    const [, botUsername, startParam] = startappM;
    const bot = (await entry.client.getEntity(botUsername)) as Api.User;
    entry.entityCache.set(entityToChatId(bot), bot);
    const result = (await entry.client.invoke(
      new Api.messages.RequestMainWebView({
        peer: bot,
        bot,
        platform: "web",
        startParam,
      }),
    )) as any;
    return result.url as string;
  }

  // Direct web app URL with a known bot
  if (botChatId) {
    await ensureEntityCached(entry, botChatId);
    const bot = entry.entityCache.get(botChatId) as Api.User | undefined;
    if (bot instanceof Api.User) {
      const result = (await entry.client.invoke(
        new Api.messages.RequestSimpleWebView({
          bot,
          url: tmeOrUrl,
          platform: "web",
        } as any),
      )) as any;
      return result.url as string;
    }
  }

  // Fallback: return URL unchanged (iframe will load it without TG auth)
  return tmeOrUrl;
}

// Re-fetches the channel from TG to get the latest membership state.
export async function checkMembership(
  entry: LiveEntry,
  chatId: string,
): Promise<boolean> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity || !(entity instanceof Api.Channel)) return false;
  try {
    const result = (await entry.client.invoke(
      new Api.channels.GetChannels({ id: [entity as Api.Channel] }),
    )) as Api.messages.Chats;
    const fresh = result.chats?.[0] as Api.Channel | undefined;
    if (fresh) {
      entry.entityCache.set(chatId, fresh);
      return !fresh.left;
    }
  } catch {}
  return false;
}

export async function joinChannel(
  entry: LiveEntry,
  chatId: string,
): Promise<JoinResult> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");
  if (!(entity instanceof Api.Channel))
    throw new Error("Only channels and supergroups can be joined this way");
  try {
    await entry.client.invoke(
      new Api.channels.JoinChannel({ channel: entity }),
    );
    (entity as any).left = false;
    return { joined: true };
  } catch (err: any) {
    // INVITE_REQUEST_SENT = group requires admin approval; request was submitted
    if (err?.message?.includes("INVITE_REQUEST_SENT")) {
      return { requestSent: true };
    }
    throw err;
  }
}

export async function markRead(
  entry: LiveEntry,
  chatId: string,
  maxId: number,
): Promise<void> {
  await ensureEntityCached(entry, chatId);
  const entity = entry.entityCache.get(chatId);
  if (!entity) throw new Error("Chat not found");
  if (chatId.startsWith("c")) {
    await entry.client.invoke(
      new Api.channels.ReadHistory({ channel: entity as any, maxId }),
    );
  } else {
    await entry.client.invoke(
      new Api.messages.ReadHistory({ peer: entity as any, maxId }),
    );
  }
}

export async function checkInvite(
  entry: LiveEntry,
  hash: string,
): Promise<TgInvitePreview> {
  const result = await entry.client.invoke(
    new Api.messages.CheckChatInvite({ hash }),
  );
  if (
    result instanceof Api.ChatInviteAlready ||
    result instanceof Api.ChatInvitePeek
  ) {
    const chat = result.chat as Api.Chat | Api.Channel;
    let chatId = "";
    let title = "";
    let memberCount = 0;
    let type: "group" | "channel" = "group";
    if (chat instanceof Api.Channel) {
      chatId = `c${chat.id}`;
      title = chat.title ?? "";
      memberCount = (chat as any).participantsCount ?? 0;
      type = chat.megagroup ? "group" : "channel";
      entry.entityCache.set(chatId, chat);
    } else if (chat instanceof Api.Chat) {
      chatId = `g${chat.id}`;
      title = chat.title ?? "";
      memberCount = (chat as any).participantsCount ?? 0;
      entry.entityCache.set(chatId, chat);
    }
    return {
      hash,
      title,
      memberCount,
      type,
      alreadyJoined: true,
      chatId: chatId || undefined,
    };
  }
  const invite = result as Api.ChatInvite;
  const type: "group" | "channel" =
    (invite as any).channel && !(invite as any).megagroup ? "channel" : "group";
  return {
    hash,
    title: (invite as any).title ?? "",
    memberCount: (invite as any).participantsCount ?? 0,
    type,
    alreadyJoined: false,
  };
}

export async function joinInvite(
  entry: LiveEntry,
  hash: string,
): Promise<TgDialogItem> {
  const updates = await entry.client.invoke(
    new Api.messages.ImportChatInvite({ hash }),
  );
  const chats = (updates as any).chats as (Api.Chat | Api.Channel)[];
  const chat = chats?.[0];
  if (!chat) throw new Error("Failed to join: no chat in response");
  let chatId: string;
  let name: string;
  let type: TgDialogItem["type"];
  let username: string | null = null;
  if (chat instanceof Api.Channel) {
    chatId = `c${chat.id}`;
    name = chat.title ?? "";
    type = chat.megagroup ? "group" : "channel";
    username = chat.username ?? null;
    entry.entityCache.set(chatId, chat);
  } else {
    chatId = `g${(chat as Api.Chat).id}`;
    name = (chat as Api.Chat).title ?? "";
    type = "group";
    entry.entityCache.set(chatId, chat as Api.Chat);
  }
  return { chatId, name, type, username, unreadCount: 0, lastMessage: null };
}

export function subscribeToMessages(
  accountId: number,
  handler: (msg: TgLiveMessage) => void,
): () => void {
  const entry = liveClients.get(accountId);
  if (!entry) return () => {};
  entry.subscribers.add(handler);
  return () => entry.subscribers.delete(handler);
}

export function subscribeToDialogs(
  accountId: number,
  handler: (dialogs: TgDialogItem[]) => void,
): () => void {
  const entry = liveClients.get(accountId);
  if (!entry) return () => {};
  entry.dialogSubscribers.add(handler);
  return () => entry.dialogSubscribers.delete(handler);
}

// --- Message cache helpers ---

const MSG_CACHE_MAX = 500;

export function getCachedMessages(
  accountId: number,
  chatId: string,
  limit: number,
  beforeId?: number,
): TgMsgPayload[] {
  const params: (number | string)[] = [accountId, chatId];
  let sql =
    "SELECT payload FROM tg_message_cache WHERE account_id = ? AND chat_id = ?";
  if (beforeId !== undefined) {
    sql += " AND msg_id < ?";
    params.push(beforeId);
  }
  sql += " ORDER BY msg_id DESC LIMIT ?";
  params.push(limit);
  const rows = db.prepare(sql).all(...params) as { payload: string }[];
  return rows.map((r) => JSON.parse(r.payload) as TgMsgPayload);
}

export function cacheMessages(
  accountId: number,
  chatId: string,
  msgs: TgMsgPayload[],
): void {
  if (!msgs.length) return;
  const insert = db.prepare(
    "INSERT OR REPLACE INTO tg_message_cache (account_id, chat_id, msg_id, msg_date, payload) VALUES (?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const msg of msgs) {
      insert.run(accountId, chatId, msg.id, msg.date, JSON.stringify(msg));
    }
  })();
  // Trim to keep only the most recent MSG_CACHE_MAX per chat
  db.prepare(
    `DELETE FROM tg_message_cache WHERE account_id = ? AND chat_id = ? AND msg_id NOT IN (
      SELECT msg_id FROM tg_message_cache WHERE account_id = ? AND chat_id = ? ORDER BY msg_id DESC LIMIT ?
    )`,
  ).run(accountId, chatId, accountId, chatId, MSG_CACHE_MAX);
}

export function clearCachedMessages(accountId: number, chatId: string): void {
  db.prepare(
    "DELETE FROM tg_message_cache WHERE account_id = ? AND chat_id = ?",
  ).run(accountId, chatId);
}

// Fetches messages newer than the last cached msg and pushes them to subscribers.
// Pass afterId to override the cache-based baseline (used by WS periodic sync).
export async function syncMessagesInBackground(
  accountId: number,
  chatId: string,
  afterId?: number,
): Promise<void> {
  const entry = liveClients.get(accountId);
  if (!entry) return;

  let maxId = afterId ?? 0;
  if (!maxId) {
    const row = db
      .prepare(
        "SELECT MAX(msg_id) as m FROM tg_message_cache WHERE account_id = ? AND chat_id = ?",
      )
      .get(accountId, chatId) as { m: number | null };
    maxId = row?.m ?? 0;
  }
  if (!maxId) return;

  const recent = await getMessages(entry, chatId, 100, 0);
  const newMsgs = recent.filter((m) => m.id > maxId);
  if (!newMsgs.length) return;
  cacheMessages(accountId, chatId, newMsgs);
  // Push oldest-first so the frontend appends in chronological order
  const ordered = newMsgs.slice().sort((a, b) => a.id - b.id);
  for (const msg of ordered) {
    entry.subscribers.forEach((sub) => sub({ chatId, message: msg }));
  }
}

// --- Dialog cache helpers ---

export function getCachedDialogs(accountId: number): TgDialogItem[] {
  const rows = db
    .prepare(
      "SELECT payload FROM tg_dialog_cache WHERE account_id = ? ORDER BY sort_order ASC",
    )
    .all(accountId) as { payload: string }[];
  return rows.map((r) => JSON.parse(r.payload) as TgDialogItem);
}

export function cacheDialogs(accountId: number, dialogs: TgDialogItem[]): void {
  if (!dialogs.length) return;
  const upsert = db.prepare(
    `INSERT INTO tg_dialog_cache (account_id, chat_id, sort_order, payload)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (account_id, chat_id) DO UPDATE SET sort_order = excluded.sort_order, payload = excluded.payload`,
  );
  db.transaction(() => {
    for (let i = 0; i < dialogs.length; i++) {
      upsert.run(accountId, dialogs[i].chatId, i, JSON.stringify(dialogs[i]));
    }
  })();
}

export async function syncDialogsInBackground(
  accountId: number,
): Promise<void> {
  const entry = liveClients.get(accountId);
  if (!entry) return;
  try {
    const dialogs = await loadDialogs(entry);
    cacheDialogs(accountId, dialogs);
    entry.dialogSubscribers.forEach((sub) => sub(dialogs));
  } catch {}
}
