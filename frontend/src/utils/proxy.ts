// Telegram speaks MTProto over SOCKS only, so an HTTP proxy -- which is what Webshare hands
// out, and what a downloaded list defaults to -- cannot carry an account's connection. Such
// an entry is still useful for the browser side (Cloudflare, Mini Apps) as a job or template
// proxy, so it stays in the list but must not be selectable as an account proxy: the backend
// drops a non-SOCKS URL and the account would connect direct without saying so.

const TG_SCHEMES = new Set(["socks", "socks4", "socks5"]);

/** Can this proxy URL carry a Telegram connection? */
export function proxySupportsTelegram(url: string | undefined): boolean {
  const scheme = proxyScheme(url);
  return !!scheme && TG_SCHEMES.has(scheme);
}

/** Scheme of a proxy URL in lower case, or undefined when it has none. */
export function proxyScheme(url: string | undefined): string | undefined {
  const match = url?.trim().match(/^([a-z][a-z0-9+.-]*):\/\//i);
  return match?.[1].toLowerCase();
}
