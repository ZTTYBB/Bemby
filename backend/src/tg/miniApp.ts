import { Api, TelegramClient } from "telegram";

// Mini App (WebView) buttons carry a bare page address. Telegram never opens that
// address directly -- it asks the server for a signed URL first, then renders it in
// a real browser view. Job automation must do the same: request the signed URL over
// MTProto, then load it in the installed Chromium so the app sees a genuine browser
// (which is what gets us past Cloudflare) and a logged-in account.
//
// Bots also put the same thing behind plain URL buttons as t.me links, either a mini
// app (`?startapp=`) or a command deep link (`?start=`), which need the same treatment
// a real client gives them rather than being loaded as web pages.

/** A t.me mini app link: `t.me/BotName[/AppShortName]?startapp=PARAM`. */
export type MiniAppLink = { botUsername: string; appShortName?: string; startParam: string };

/** A t.me bot command deep link: `t.me/BotName?start=PARAM`. */
export type BotStartLink = { botUsername: string; startParam: string };

/**
 * An inline button that leads somewhere outside the chat.
 * - `miniApp` -- opens a Mini App, so Telegram must sign the URL first
 * - `startLink` -- a deep link that is followed by sending `/start PARAM` to that bot,
 *   not by loading a page
 */
export type WebButton = {
  text: string;
  url: string;
  miniApp: boolean;
  miniAppLink?: MiniAppLink;
  startLink?: BotStartLink;
};

/**
 * Parses a t.me/BotName[/AppShortName]?startapp=PARAM mini app link.
 * The startapp value is percent-decoded and stripped of base64 padding:
 * Telegram only accepts [A-Za-z0-9_-] in start_param, so raw links carrying
 * %3D-encoded padding fail with START_PARAM_INVALID (issue seen with
 * telegram.me/.../panel?startapp=...%3D%3D).
 */
export function parseMiniAppLink(tmeOrUrl: string): MiniAppLink | null {
  const m = tmeOrUrl.match(
    /t(?:elegram)?\.me\/([A-Za-z]\w+)(?:\/([A-Za-z]\w+))?\?startapp=([^&\s]+)/i,
  );
  if (!m) return null;
  let startParam = m[3];
  try {
    startParam = decodeURIComponent(startParam);
  } catch {
    // Malformed escape sequence -- keep the raw value
  }
  startParam = startParam.replace(/=+$/, "");
  return { botUsername: m[1], appShortName: m[2], startParam };
}

/**
 * Parses a t.me/BotName?start=PARAM command deep link. Clicking such a button in a
 * real client opens the bot chat and sends `/start PARAM`, which is how bots hand a
 * group verification over to a private chat.
 */
export function parseBotStartLink(tmeOrUrl: string): BotStartLink | null {
  const m = tmeOrUrl.match(/t(?:elegram)?\.me\/([A-Za-z]\w+)\?start=([^&\s]+)/i);
  if (!m) return null;
  let startParam = m[2];
  try {
    startParam = decodeURIComponent(startParam);
  } catch {
    // Malformed escape sequence -- keep the raw value
  }
  return { botUsername: m[1], startParam };
}

/** Reads the destination off an inline button, classifying what opening it means. */
export function webButtonOf(btn: Api.TypeKeyboardButton): WebButton | undefined {
  if (btn instanceof Api.KeyboardButtonWebView || btn instanceof Api.KeyboardButtonSimpleWebView) {
    return { text: btn.text, url: btn.url, miniApp: true };
  }
  if (btn instanceof Api.KeyboardButtonUrl) {
    const miniAppLink = parseMiniAppLink(btn.url);
    if (miniAppLink) return { text: btn.text, url: btn.url, miniApp: true, miniAppLink };
    const startLink = parseBotStartLink(btn.url);
    if (startLink) return { text: btn.text, url: btn.url, miniApp: false, startLink };
    return { text: btn.text, url: btn.url, miniApp: false };
  }
  return undefined;
}

/**
 * Resolves a t.me mini app link to the signed URL Telegram would open: a named app
 * (`/panel?startapp=`) via RequestAppWebView, a main app via RequestMainWebView.
 */
async function resolveMiniAppLink(
  client: TelegramClient,
  link: MiniAppLink,
): Promise<{ url: string; resolved: boolean }> {
  try {
    const bot = (await client.getEntity(link.botUsername)) as Api.User;
    if (link.appShortName) {
      const res = (await client.invoke(
        new Api.messages.RequestAppWebView({
          peer: bot,
          app: new Api.InputBotAppShortName({
            botId: new Api.InputUser({ userId: bot.id, accessHash: bot.accessHash! }),
            shortName: link.appShortName,
          }),
          startParam: link.startParam,
          platform: "web",
          writeAllowed: true,
        }),
      )) as Api.WebViewResultUrl;
      if (res?.url) return { url: res.url, resolved: true };
    } else {
      const res = (await client.invoke(
        new Api.messages.RequestMainWebView({
          peer: bot,
          bot,
          platform: "web",
          startParam: link.startParam,
        }),
      )) as Api.WebViewResultUrl;
      if (res?.url) return { url: res.url, resolved: true };
    }
  } catch {
    /* bot refused, or the app short name is wrong -- caller falls back */
  }
  return { url: "", resolved: false };
}

/**
 * Asks Telegram for the signed Mini App URL behind a WebView button: the same page
 * plus the `tgWebAppData` fragment identifying the account. Without it the app loads
 * logged out. Falls back to the bare URL when the bot refuses the request.
 */
export async function resolveMiniAppUrl(
  client: TelegramClient,
  bot: Api.TypeEntityLike,
  url: string,
  peer?: Api.TypeEntityLike,
): Promise<{ url: string; resolved: boolean }> {
  const platform = "web";

  // Inline-keyboard buttons use RequestWebView; its URL carries the full init data
  // (query_id included), which apps that call back into the bot need.
  try {
    const res = (await client.invoke(
      new Api.messages.RequestWebView({ peer: peer ?? bot, bot, url, platform }),
    )) as Api.WebViewResultUrl;
    if (res?.url) return { url: res.url, resolved: true };
  } catch {
    /* not accepted as an inline webview -- try the simple form below */
  }

  try {
    const res = (await client.invoke(
      new Api.messages.RequestSimpleWebView({ bot, url, platform }),
    )) as Api.WebViewResultUrl;
    if (res?.url) return { url: res.url, resolved: true };
  } catch {
    /* bot refused; caller falls back to the bare URL */
  }

  return { url, resolved: false };
}

/**
 * Signs an address the operator typed rather than one read off a button. A
 * `t.me/<bot>/<app>` link names its own bot and is resolved from the link; anything else
 * is signed through `bot`, which is the only way Telegram will attach the init data.
 * Unsigned means the app would load logged out, so the caller decides whether to go on.
 */
export async function openableMiniAppUrl(
  client: TelegramClient,
  url: string,
  bot?: Api.TypeEntityLike,
): Promise<{ url: string; signed: boolean }> {
  const link = parseMiniAppLink(url);
  if (link) {
    const viaLink = await resolveMiniAppLink(client, link);
    // The bare t.me link is a Telegram page rather than the app, so it is no fallback
    return { url: viaLink.resolved ? viaLink.url : url, signed: viaLink.resolved };
  }
  if (!bot) return { url, signed: false };
  const viaBot = await resolveMiniAppUrl(client, bot, url);
  return { url: viaBot.url, signed: viaBot.resolved };
}

/**
 * Turns a matched inline button into an address a browser can open: plain URL
 * buttons as-is, Mini App buttons signed by Telegram. For a webview button the app's
 * owner is the message sender (or its via-bot); in a bot DM that is the chat peer
 * itself. A t.me mini app link names its own bot, so it is resolved from the link.
 */
export async function openableButtonUrl(
  client: TelegramClient,
  web: WebButton,
  peer: Api.TypeEntityLike,
  msg?: Api.Message,
): Promise<{ url: string; signed: boolean }> {
  if (web.miniAppLink) {
    const viaLink = await resolveMiniAppLink(client, web.miniAppLink);
    // No usable fallback: the bare t.me link is a Telegram page, not the app
    return { url: viaLink.resolved ? viaLink.url : web.url, signed: viaLink.resolved };
  }

  if (!web.miniApp) return { url: web.url, signed: false };

  const sender = (msg as any)?.viaBotId ?? msg?.senderId ?? undefined;
  if (sender) {
    const viaSender = await resolveMiniAppUrl(client, sender, web.url, peer);
    if (viaSender.resolved) return { url: viaSender.url, signed: true };
  }

  const viaPeer = await resolveMiniAppUrl(client, peer, web.url, peer);
  return { url: viaPeer.url, signed: viaPeer.resolved };
}
