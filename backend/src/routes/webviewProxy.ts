import { Router } from "express";
import { assertPublicUrl, ssrfSafeFetch } from "../tg/safeFetch";
import {
  resolveWebviewTicket,
  ticketAllowsUrl,
  type WebviewMode,
  type WebviewTicket,
} from "../tg/webviewTickets";

// Serves a page that refuses to be framed -- most Mini Apps now send
// `frame-ancestors 'self' https://web.telegram.org` -- so the messenger viewer can still
// show it. The copy is served from Bemby's own origin with those headers dropped, which is
// only safe because of two things, and both must stay true:
//
//  1. The iframe gets no `allow-same-origin`, so the page runs in an opaque origin and
//     cannot reach Bemby's storage, cookies or DOM.
//  2. The address carries a ticket rather than a session token. Scripts on the page can read
//     their own URL, so anything in it is theirs; a ticket only authorises fetching from the
//     site it was issued for. This router is therefore mounted outside `requireAuth` -- the
//     ticket is the whole credential, and it grants nothing of Bemby's.
//
// Because the origin is opaque, the page's own requests reach us cross-origin (`Origin:
// null`), which is why the responses carry `Access-Control-Allow-Origin: *` and preflights
// are answered here.

const router = Router();

/** The path a proxied page's own requests come back to. */
const PROXY_PATH = "/api/webview/proxy";

/** Headers that belong to this hop, or to Bemby, and must not be passed upstream. */
const DROP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "content-length",
  // Bemby's own cookies must never reach the site
  "cookie",
  // Ours to set: the site is entitled to think the request came from its own page
  "origin",
  "referer",
  "accept-encoding",
]);

const UA_APP =
  "Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120 Mobile Safari/537.36 Telegram/10.0";
const UA_PAGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126 Safari/537.36";

function allowCors(res: Parameters<Parameters<typeof router.options>[1]>[1], reqHeaders?: string) {
  // The sandboxed page is an opaque origin, so `*` is the only value that matches it. No
  // credentials are involved: cookies are never forwarded either way.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", reqHeaders || "*");
  res.setHeader("Access-Control-Max-Age", "600");
}

/**
 * Injected ahead of the page's own scripts.
 *
 * A proxied page believes it is served from Bemby, which breaks it in three ways that no
 * amount of rewriting the HTML can fix: requests it builds at runtime point at the wrong
 * origin, storage throws because the origin is opaque, and the Telegram bridge has no host
 * to talk to. Each is patched here rather than left to fail silently.
 */
function runtimeShim(base: string, domain: string, ticketId: string, mode: WebviewMode): string {
  const config = JSON.stringify({
    base,
    domain,
    proxy: `${PROXY_PATH}?t=${encodeURIComponent(ticketId)}&url=`,
    path: PROXY_PATH,
  });

  // telegram-web-app.js posts its events to the host client. In a frame it would postMessage
  // to a Telegram origin, which is not us, so the message is dropped and calls made during
  // boot can throw. This is the bridge a Telegram mobile webview exposes, so the script takes
  // that path instead and reads the signed initData from the URL fragment as normal. Events
  // the client would send back (a main button press, a popup answer) have no sender here.
  const telegramBridge =
    mode === "app"
      ? `
  window.TelegramWebviewProxy = window.TelegramWebviewProxy || {
    postEvent: function (type, data) {
      try {
        window.dispatchEvent(new CustomEvent("tg-post", { detail: { type: type, data: data } }));
      } catch (e) {}
    }
  };`
      : "";

  return `<script>(function () {
  var CFG = ${config};
  var here = location.origin;

  function sameParty(host) {
    host = String(host).toLowerCase();
    return host === CFG.domain || host.slice(-(CFG.domain.length + 1)) === "." + CFG.domain;
  }

  // The address a request should really go to. Relative URLs resolve against the page's own
  // address on the site, not against Bemby; a URL the page built from location.origin is
  // read as one of its own paths; anything on another party's domain is left to go direct,
  // since the ticket would not cover it anyway.
  function route(raw) {
    var u = String(raw == null ? "" : raw);
    if (!u || /^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i.test(u)) return raw;
    var abs;
    try { abs = new URL(u, CFG.base).toString(); } catch (e) { return raw; }
    if (abs.indexOf(here) === 0) {
      var rest = abs.slice(here.length);
      if (rest.indexOf(CFG.path) === 0) return raw;
      try { abs = new URL(rest, CFG.base).toString(); } catch (e) { return raw; }
    }
    var host;
    try { host = new URL(abs).hostname; } catch (e) { return raw; }
    if (!sameParty(host)) return abs;
    return CFG.proxy + encodeURIComponent(abs);
  }

  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof input === "string" || input instanceof URL) {
          return origFetch.call(this, route(input), init);
        }
        if (input && typeof input.url === "string") {
          var routed = route(input.url);
          if (routed !== input.url) return origFetch.call(this, new Request(routed, input), init);
        }
      } catch (e) {}
      return origFetch.call(this, input, init);
    };
  }

  var xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function () {
    var args = Array.prototype.slice.call(arguments);
    if (args.length > 1) args[1] = route(args[1]);
    return xhrOpen.apply(this, args);
  };

  if (navigator.sendBeacon) {
    var beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) { return beacon(route(url), data); };
  }

  if (window.EventSource) {
    var ES = window.EventSource;
    window.EventSource = function (url, cfg) { return new ES(route(url), cfg); };
    window.EventSource.prototype = ES.prototype;
  }

  // Storage throws outright in an opaque origin, and an app that stores a token on boot dies
  // on the first line. In-memory stand-ins last as long as the panel is open, which is the
  // life of the session anyway.
  function memoryStore() {
    var map = {};
    return {
      getItem: function (k) { var s = String(k); return Object.prototype.hasOwnProperty.call(map, s) ? map[s] : null; },
      setItem: function (k, v) { map[String(k)] = String(v); },
      removeItem: function (k) { delete map[String(k)]; },
      clear: function () { map = {}; },
      key: function (i) { var ks = Object.keys(map); return i < ks.length ? ks[i] : null; },
      get length() { return Object.keys(map).length; }
    };
  }
  ["localStorage", "sessionStorage"].forEach(function (name) {
    var usable = false;
    try {
      var store = window[name];
      store.setItem("__bemby_probe", "1");
      store.removeItem("__bemby_probe");
      usable = true;
    } catch (e) {}
    if (!usable) {
      try { Object.defineProperty(window, name, { value: memoryStore(), configurable: true }); } catch (e) {}
    }
  });

${telegramBridge}
})();</script>`;
}

/** Rewrites a page so its subresources and links come back through this proxy. */
function rewriteHtml(
  html: string,
  finalUrl: string,
  ticket: WebviewTicket,
  domain: string,
): string {
  const proxyPrefix = `${PROXY_PATH}?t=${encodeURIComponent(ticket.id)}&url=`;
  const toProxy = (resourceUrl: string): string => {
    if (!resourceUrl || resourceUrl.startsWith("data:") || resourceUrl.includes(PROXY_PATH)) {
      return resourceUrl;
    }
    try {
      return `${proxyPrefix}${encodeURIComponent(new URL(resourceUrl, finalUrl).toString())}`;
    } catch {
      return resourceUrl;
    }
  };
  const toAbs = (resourceUrl: string): string => {
    if (!resourceUrl || resourceUrl.startsWith("data:") || /^https?:\/\//i.test(resourceUrl)) {
      return resourceUrl;
    }
    try {
      return new URL(resourceUrl, finalUrl).toString();
    } catch {
      return resourceUrl;
    }
  };

  // A <base href> would send our relative proxy URLs back to the site, and a meta CSP would
  // hold the proxied copy to rules written for the original origin
  let out = html.replace(/<base\b[^>]*>/gi, "");
  out = out.replace(
    /<meta\b[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi,
    "",
  );

  // Scripts and stylesheets come through the proxy: a module is fetched with CORS, which the
  // site will not grant an opaque origin. The whole opening tag is rewritten rather than the
  // attributes before `src`, since `crossorigin` is as likely to sit after it.
  out = out.replace(/<script\b[^>]*>/gi, (tag) => {
    if (!/\ssrc\s*=\s*["']/i.test(tag)) return tag;
    return tag
      .replace(/\bcrossorigin\b(?:\s*=\s*["'][^"']*["'])?/gi, "")
      .replace(
        /(\ssrc\s*=\s*)(["'])([^"']+)\2/i,
        (_m, attr, q, src) => `${attr}${q}${toProxy(src)}${q}`,
      );
  });
  out = out.replace(/<link\b[^>]+>/gi, (linkTag) => {
    const isScriptResource =
      /rel\s*=\s*["']?(stylesheet|modulepreload)["']?/i.test(linkTag) ||
      (/rel\s*=\s*["']?preload["']?/i.test(linkTag) &&
        /\bas\s*=\s*["']?script["']?/i.test(linkTag));
    if (!isScriptResource) {
      return linkTag.replace(
        /(href\s*=\s*)(["'])([^"']+)\2/i,
        (_m, attr, q, href) => `${attr}${q}${toAbs(href)}${q}`,
      );
    }
    return linkTag
      .replace(/\bcrossorigin\b(?:\s*=\s*["'][^"']*["'])?/gi, "")
      .replace(
        /(href\s*=\s*)(["'])([^"']+)\2/i,
        (_m, attr, q, href) => `${attr}${q}${toProxy(href)}${q}`,
      );
  });

  // Images, fonts and form targets load straight from the site, so they only need absolving
  // of the missing <base href>
  out = out.replace(
    /(\b(?:src|action)\s*=\s*)(["'])(?!data:|https?:\/\/|\/\/|#|\/api\/)([^"']+)\2/gi,
    (_m, attr, q, val) => `${attr}${q}${toAbs(val)}${q}`,
  );
  out = out.replace(/(\bsrcset\s*=\s*)(["'])([^"']+)\2/gi, (_m, attr, q, val: string) => {
    const rewritten = val
      .split(",")
      .map((part) => {
        const [u, ...rest] = part.trim().split(/\s+/);
        if (!u || /^(data:|https?:\/\/|\/\/)/i.test(u)) return part.trim();
        return [toAbs(u), ...rest].join(" ");
      })
      .join(", ");
    return `${attr}${q}${rewritten}${q}`;
  });

  // A plain page is browsed, so its links stay inside the viewer. An app routes its own
  // navigation through the shim instead.
  if (ticket.mode === "page") {
    out = out.replace(
      /(<a\b[^>]*?\shref\s*=\s*)(["'])([^"']+)\2/gi,
      (m, prefix, q, href) => {
        if (/^(#|mailto:|tel:|javascript:|data:)/i.test(href)) return m;
        const abs = toAbs(href);
        if (!/^https?:\/\//i.test(abs)) return m;
        return `${prefix}${q}${toProxy(abs)}${q}`;
      },
    );
  }

  // Vite-built apps import their chunks by absolute path at runtime; the map sends those
  // through the proxy instead of at Bemby's root.
  const encodedBase = encodeURIComponent(`${new URL(finalUrl).origin}/`);
  const scopedBase = `${proxyPrefix}${encodedBase}`;
  const importMap = JSON.stringify({
    scopes: {
      [PROXY_PATH]: { "/": scopedBase, [`${new URL(finalUrl).origin}/`]: scopedBase },
    },
  });
  const head = `<script type="importmap">${importMap}</script>\n${runtimeShim(
    finalUrl,
    domain,
    ticket.id,
    ticket.mode,
  )}`;

  // Both must precede every script on the page, module or not
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => `${m}\n${head}`);
  } else {
    out = `${head}\n${out}`;
  }
  return out;
}

router.options("/proxy", (req, res) => {
  allowCors(res, req.headers["access-control-request-headers"] as string | undefined);
  res.status(204).end();
});

router.all("/proxy", async (req, res) => {
  const ticket = resolveWebviewTicket(req.query.t as string | undefined);
  allowCors(res, req.headers["access-control-request-headers"] as string | undefined);
  if (!ticket) {
    res.status(401).json({ error: "This viewer session has expired. Open the app again." });
    return;
  }

  const url = req.query.url as string;
  if (!url || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: "valid url required" });
    return;
  }
  // The ticket is what bounds the proxy: without this it would fetch anything for anyone
  // holding one, which is a relay rather than a viewer.
  if (!ticketAllowsUrl(ticket, url)) {
    res.status(403).json({ error: "outside this viewer session" });
    return;
  }
  try {
    await assertPublicUrl(url);
  } catch {
    res.status(400).json({ error: "URL not allowed" });
    return;
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (DROP_REQUEST_HEADERS.has(name.toLowerCase()) || value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  // Lowercase throughout: Express delivers them that way, and a record holding both cases of
  // one name is filled into Headers by appending, which would send the value twice.
  headers["user-agent"] = ticket.mode === "app" ? UA_APP : UA_PAGE;
  // The site is entitled to think the request came from its own page
  headers["referer"] = `${ticket.origin}/`;
  headers["origin"] = ticket.origin;
  headers["accept-language"] ??= "en-US,en;q=0.9";

  // Raw bytes, so a body of any content type reaches the site exactly as the page sent it
  const body =
    req.method === "GET" || req.method === "HEAD" || !Buffer.isBuffer(req.body) || !req.body.length
      ? undefined
      : new Uint8Array(req.body);

  try {
    const upstream = await ssrfSafeFetch(url, { method: req.method, headers, body });
    const contentType = upstream.headers.get("content-type") ?? "text/html";

    res.status(upstream.status);
    res.setHeader("Content-Type", contentType);
    // Only Bemby may frame the copy: the proxy is not a way to launder framing for the web
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Cache-Control", "no-store");

    if (!contentType.includes("text/html")) {
      res.send(Buffer.from(await upstream.arrayBuffer()));
      return;
    }

    const finalUrl = (upstream.url || url).split("#")[0];
    const domain = new URL(finalUrl).hostname.toLowerCase().split(".").slice(-2).join(".");
    res.send(rewriteHtml(await upstream.text(), finalUrl, ticket, domain));
  } catch (err: any) {
    res.status(502).json({ error: err?.message ?? "proxy failed" });
  }
});

export default router;
