import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { getJwtSecret } from "../middleware/auth";

const router = Router();

// Path-based mini app proxy: /api/miniapp-proxy/:token/:b64origin/*
//
// Token and bot origin embedded in URL path so Vite chunk imports
// (./chunk.js) automatically resolve through this proxy.
//
// URL structure:
//   /api/miniapp-proxy/{jwtToken}/{base64(botOrigin)}/{botPath}

function parseProxyParams(req: Request): { token: string; b64origin: string; subpath: string } {
  return {
    token: req.params.token,
    b64origin: req.params.b64origin,
    subpath: (req.params as any)[0] ?? "",
  };
}

async function validateAndDecode(
  token: string,
  b64origin: string,
  res: Response,
): Promise<string | null> {
  try {
    jwt.verify(token, getJwtSecret());
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
    return null;
  }
  try {
    const origin = Buffer.from(b64origin, "base64").toString("utf8");
    new URL(origin);
    return origin;
  } catch {
    res.status(400).json({ error: "Invalid origin" });
    return null;
  }
}

router.get("/:token/:b64origin/*", async (req, res) => {
  const { token, b64origin, subpath } = parseProxyParams(req);
  const botOrigin = await validateAndDecode(token, b64origin, res);
  if (!botOrigin) return;

  const queryStr = new URLSearchParams(
    Object.entries(req.query as Record<string, string>).filter(([k]) => k !== "token"),
  ).toString();
  const upstreamUrl = `${botOrigin}/${subpath}${queryStr ? `?${queryStr}` : ""}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36 Telegram/10.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.removeHeader("X-Frame-Options");
    res.removeHeader("Content-Security-Policy");

    if (contentType.includes("text/html")) {
      let html = await upstream.text();

      html = html.replace(/<base\b[^>]*>/gi, "");

      const proxyBase = `/api/miniapp-proxy/${token}/${b64origin}/`;
      const baseTag = `<base href="${proxyBase}">`;
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${baseTag}`);
      } else {
        html = baseTag + "\n" + html;
      }

      const toProxyUrl = (resourceUrl: string): string => {
        if (!resourceUrl || resourceUrl.startsWith("data:")) return resourceUrl;
        try {
          const parsed = new URL(resourceUrl);
          if (parsed.origin === botOrigin) {
            return `${proxyBase}${parsed.pathname.replace(/^\//, "")}${parsed.search}`;
          }
        } catch { /* relative -- base href handles it */ }
        return resourceUrl;
      };

      html = html.replace(
        /(<script\b)([^>]*?)\s(src\s*=\s*)(["'])([^"']+)\4/gi,
        (m, tag, attrs, srcAttr, q, src) => {
          const cleanAttrs = attrs.replace(/\bcrossorigin\b(?:\s*=\s*["'][^"']*["'])?/gi, "").trimEnd();
          return `${tag}${cleanAttrs} ${srcAttr}${q}${toProxyUrl(src)}${q}`;
        },
      );

      html = html.replace(/<link\b[^>]+>/gi, (linkTag) => {
        const isScriptResource =
          /rel\s*=\s*["']?(stylesheet|modulepreload)["']?/i.test(linkTag) ||
          (/rel\s*=\s*["']?preload["']?/i.test(linkTag) && /\bas\s*=\s*["']?script["']?/i.test(linkTag));
        if (!isScriptResource) return linkTag;
        return linkTag
          .replace(/\bcrossorigin\b(?:\s*=\s*["'][^"']*["'])?/gi, "")
          .replace(/(href\s*=\s*)(["'])([^"']+)\2/i, (_m, attr, q, href) => `${attr}${q}${toProxyUrl(href)}${q}`);
      });

      res.send(html);
    } else {
      const buf = await upstream.arrayBuffer();
      res.send(Buffer.from(buf));
    }
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// Forward POST requests (e.g. Cloudflare RUM beacon, API calls) to the bot origin
router.post("/:token/:b64origin/*", async (req, res) => {
  const { token, b64origin, subpath } = parseProxyParams(req);
  const botOrigin = await validateAndDecode(token, b64origin, res);
  if (!botOrigin) return;

  const queryStr = new URLSearchParams(
    Object.entries(req.query as Record<string, string>).filter(([k]) => k !== "token"),
  ).toString();
  const upstreamUrl = `${botOrigin}/${subpath}${queryStr ? `?${queryStr}` : ""}`;

  try {
    const contentType = req.headers["content-type"] ?? "application/json";
    const body = contentType.includes("json") ? JSON.stringify(req.body) : req.body;
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
      redirect: "follow",
    });
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(upstream.status).send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

export default router;
