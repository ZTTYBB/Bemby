import { randomBytes } from "crypto";

// A page shown in the messenger viewer is served from Bemby's own origin by the proxy, so
// whatever credential that page's address carries is readable by the site's own scripts
// (location.search is not hidden from them). A Bemby session token there would hand a
// third-party page the whole API. A ticket is issued instead: it authorises one thing --
// fetching from the site it was issued for, for a while -- so a page that reads its own
// ticket gains nothing it could not already do by talking to its own server.

export type WebviewMode = "app" | "page";

export type WebviewTicket = {
  id: string;
  /** The address the ticket was issued for, which is what the proxy will serve. */
  origin: string;
  host: string;
  /** `app` also injects the Mini App runtime shim; `page` is a plain web page. */
  mode: WebviewMode;
  expiresAt: number;
};

/** Long enough for a session in the viewer, short enough that a leaked ticket goes stale. */
const TTL_MS = 30 * 60_000;

/** Cap so a long session cannot grow the map without bound; oldest go first. */
const MAX_TICKETS = 200;

const tickets = new Map<string, WebviewTicket>();

function sweep(): void {
  const now = Date.now();
  for (const [id, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(id);
  while (tickets.size >= MAX_TICKETS) {
    const oldest = tickets.keys().next();
    if (oldest.done) break;
    tickets.delete(oldest.value);
  }
}

/** Issues a ticket for one address. Throws when the URL is not one that can be proxied. */
export function issueWebviewTicket(url: string, mode: WebviewMode): WebviewTicket {
  const parsed = new URL(url);
  if (!/^https?:$/i.test(parsed.protocol)) throw new Error("Only http(s) allowed");
  sweep();
  const ticket: WebviewTicket = {
    id: randomBytes(24).toString("base64url"),
    origin: parsed.origin,
    host: parsed.hostname.toLowerCase(),
    mode,
    expiresAt: Date.now() + TTL_MS,
  };
  tickets.set(ticket.id, ticket);
  return ticket;
}

export function resolveWebviewTicket(id: string | undefined): WebviewTicket | undefined {
  if (!id) return undefined;
  const ticket = tickets.get(id);
  if (!ticket) return undefined;
  if (ticket.expiresAt <= Date.now()) {
    tickets.delete(id);
    return undefined;
  }
  return ticket;
}

/** The site's own domain, as far as a host comparison needs it. */
function baseDomain(host: string): string {
  const labels = host.split(".");
  return labels.length <= 2 ? host : labels.slice(-2).join(".");
}

/**
 * Whether a ticket may fetch an address: its own origin, or another host on the same domain.
 * Apps commonly serve their page and their API from sibling hosts, so pinning to the exact
 * origin would break them, while allowing anything at all would make the proxy a relay for
 * any page holding a ticket.
 *
 * The domain is taken as the last two labels, which is one level too generous under a
 * multi-label public suffix (`example.co.uk`). It bounds the ticket to one party either way.
 */
export function ticketAllowsUrl(ticket: WebviewTicket, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/i.test(parsed.protocol)) return false;
  if (parsed.origin === ticket.origin) return true;
  const host = parsed.hostname.toLowerCase();
  const domain = baseDomain(ticket.host);
  return host === domain || host.endsWith(`.${domain}`);
}
