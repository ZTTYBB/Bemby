import { Api, TelegramClient } from "telegram";

// Mini App (WebView) buttons carry a bare page address. Telegram never opens that
// address directly -- it asks the server for a signed URL first, then renders it in
// a real browser view. Job automation must do the same: request the signed URL over
// MTProto, then load it in the installed Chromium so the app sees a genuine browser
// (which is what gets us past Cloudflare) and a logged-in account.

/** A web-openable inline button: a plain URL button, or a Mini App (WebView) button. */
export type WebButton = { text: string; url: string; miniApp: boolean };

/** Reads the web address off an inline button, flagging Mini App buttons. */
export function webButtonOf(btn: Api.TypeKeyboardButton): WebButton | undefined {
  if (btn instanceof Api.KeyboardButtonUrl) {
    return { text: btn.text, url: btn.url, miniApp: false };
  }
  if (btn instanceof Api.KeyboardButtonWebView || btn instanceof Api.KeyboardButtonSimpleWebView) {
    return { text: btn.text, url: btn.url, miniApp: true };
  }
  return undefined;
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
 * Turns a matched inline button into an address a browser can open: plain URL
 * buttons as-is, Mini App buttons signed by Telegram. The app's owner is the
 * message sender (or its via-bot); in a bot DM that is the chat peer itself.
 */
export async function openableButtonUrl(
  client: TelegramClient,
  web: WebButton,
  peer: Api.TypeEntityLike,
  msg?: Api.Message,
): Promise<{ url: string; signed: boolean }> {
  if (!web.miniApp) return { url: web.url, signed: false };

  const sender = (msg as any)?.viaBotId ?? msg?.senderId ?? undefined;
  if (sender) {
    const viaSender = await resolveMiniAppUrl(client, sender, web.url, peer);
    if (viaSender.resolved) return { url: viaSender.url, signed: true };
  }

  const viaPeer = await resolveMiniAppUrl(client, peer, web.url, peer);
  return { url: viaPeer.url, signed: viaPeer.resolved };
}
