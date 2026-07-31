import dns from "dns";
import net from "net";

// Fetching an address the operator supplied means the server can be pointed at anything it
// can reach, so every such fetch goes through here: the host is resolved and checked before
// a connection is made, and again on every redirect.

/** Rejects IPs in private/reserved ranges, to prevent SSRF against internal services. */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd");
  }
  return true; // reject unrecognised formats
}

export async function assertPublicUrl(rawUrl: string): Promise<void> {
  const parsed = new URL(rawUrl);
  if (!/^https?:$/i.test(parsed.protocol)) throw new Error("Only http(s) allowed");
  const hostname = parsed.hostname;
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new Error("Private IP not allowed");
    return;
  }
  // Resolve to IP before fetching so literal hostname tricks don't bypass the check
  const { address } = await dns.promises
    .lookup(hostname)
    .catch(async () => dns.promises.lookup(hostname, { family: 6 }));
  if (isBlockedIp(address)) throw new Error("Private IP not allowed");
}

/**
 * Validates the initial URL and every redirect target against `assertPublicUrl` before
 * following it, so a public host cannot 3xx-redirect the request to localhost, the cloud
 * metadata service, or anything else internal.
 */
export async function ssrfSafeFetch(
  startUrl: string,
  init: RequestInit,
  maxHops = 5,
): Promise<globalThis.Response> {
  let current = startUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    await assertPublicUrl(current);
    const resp = await fetch(current, { ...init, redirect: "manual" });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (!location) return resp;
      current = new URL(location, current).toString();
      continue;
    }
    return resp;
  }
  throw new Error("Too many redirects");
}

/** Whether a response's headers let another origin frame it. */
export function headersAllowFraming(headers: Headers): boolean {
  const xfo = (headers.get("x-frame-options") ?? "").toLowerCase();
  if (xfo.includes("deny") || xfo.includes("sameorigin")) return false;
  const csp = headers.get("content-security-policy") ?? "";
  const m = csp.match(/frame-ancestors([^;]*)/i);
  // frame-ancestors listing anything but a wildcard will not include our origin
  if (m && !m[1].trim().toLowerCase().split(/\s+/).includes("*")) return false;
  return true;
}

/** Probes a URL to see whether it can be shown in the messenger's webview iframe. */
export async function isFrameable(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    let resp = await fetch(url, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
    if (resp.status === 405 || resp.status === 501) {
      resp = await fetch(url, { redirect: "follow", signal: ctrl.signal });
      resp.body?.cancel().catch(() => {});
    }
    return headersAllowFraming(resp.headers);
  } catch {
    // Unreachable from the backend; let the browser iframe try anyway
    return true;
  } finally {
    clearTimeout(timer);
  }
}
