import { Router } from "express";
import {
  getLiveClient,
  loadDialogs,
  getMessages,
  sendMessage,
  getContacts,
  addContact,
  searchPeers,
  fetchPhoto,
  fetchAvatar,
  getEntityDetails,
  muteDialog,
  pinDialog,
  clickButton,
  sendReaction,
  getThreadMessages,
  getBotCommands,
  markRead,
  resolvePeer,
  reconnectClient,
  subscribeToMessages,
  getFolders,
  checkInvite,
  joinInvite,
  isAuthError,
  markSessionExpired,
  getCachedMessages,
  cacheMessages,
  clearCachedMessages,
  syncMessagesInBackground,
  joinChannel,
  getCachedDialogs,
  cacheDialogs,
  syncDialogsInBackground,
  fetchAvatarsBatch,
  checkMembership,
  resolveWebApp,
  startBot,
  getPinnedMessage,
} from "../tg/liveClient";
import type { Response } from "express";

// Centralised error response: marks session expired for auth errors automatically.
function tgError(err: any, accountId: number, res: Response): void {
  if (isAuthError(err?.message ?? "")) markSessionExpired(accountId);
  res.status(500).json({ error: err?.message ?? "Unknown error" });
}

const router = Router();

// GET /miniapp-proxy -- proxy mini app content through the backend.
// For HTML: rewrites <script src> and <link href> (stylesheet/modulepreload) so all
// JS/CSS also flows through this proxy, bypassing CORS and X-Frame-Options on the bot server.
// The fragment (#tgWebAppData=...) stays in the iframe src so window.location.hash works normally.
router.get("/miniapp-proxy", async (req, res) => {
  const url = req.query.url as string;
  const token = (req.query.token as string) ?? "";
  if (!url || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: "valid url required" });
    return;
  }
  try {
    const upstream = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36 Telegram/10.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    const contentType = upstream.headers.get("content-type") ?? "text/html";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.removeHeader("X-Frame-Options");
    res.removeHeader("Content-Security-Policy");

    if (contentType.includes("text/html")) {
      let html = await upstream.text();
      const finalUrl = (upstream.url || url).split("#")[0];
      const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";

      // Strip any <base href> the bot's own HTML injects -- it would redirect our
      // relative proxy URLs to the bot server instead of our backend
      html = html.replace(/<base\b[^>]*>/gi, "");

      const toProxyUrl = (resourceUrl: string): string => {
        if (!resourceUrl || resourceUrl.startsWith("data:") || resourceUrl.includes("/miniapp-proxy")) {
          return resourceUrl;
        }
        const abs = /^https?:\/\//i.test(resourceUrl)
          ? resourceUrl
          : new URL(resourceUrl, finalUrl).toString();
        // Relative path -- without <base href> this resolves against our backend origin correctly
        return `/api/tg-client/miniapp-proxy?url=${encodeURIComponent(abs)}${tokenParam}`;
      };

      const toAbsUrl = (resourceUrl: string): string => {
        if (!resourceUrl || resourceUrl.startsWith("data:") || /^https?:\/\//i.test(resourceUrl)) {
          return resourceUrl;
        }
        try { return new URL(resourceUrl, finalUrl).toString(); } catch { return resourceUrl; }
      };

      // Rewrite <script src="..."> through proxy -- strip crossorigin (same-origin after rewrite)
      html = html.replace(
        /(<script\b)([^>]*?)\s(src\s*=\s*)(["'])([^"']+)\4/gi,
        (m, tag, attrs, srcAttr, q, src) => {
          const cleanAttrs = attrs.replace(/\bcrossorigin\b(?:\s*=\s*["'][^"']*["'])?/gi, "").trimEnd();
          return `${tag}${cleanAttrs} ${srcAttr}${q}${toProxyUrl(src)}${q}`;
        },
      );

      // Rewrite <link href="..."> for stylesheets, modulepreload, and script preloads through proxy
      html = html.replace(/<link\b[^>]+>/gi, (linkTag) => {
        const isScriptResource =
          /rel\s*=\s*["']?(stylesheet|modulepreload)["']?/i.test(linkTag) ||
          (/rel\s*=\s*["']?preload["']?/i.test(linkTag) && /\bas\s*=\s*["']?script["']?/i.test(linkTag));
        if (!isScriptResource) {
          // For icon, dns-prefetch, etc. just make relative URLs absolute
          return linkTag.replace(/(href\s*=\s*)(["'])([^"']+)\2/i, (_m, attr, q, href) => `${attr}${q}${toAbsUrl(href)}${q}`);
        }
        return linkTag
          .replace(/\bcrossorigin\b(?:\s*=\s*["'][^"']*["'])?/gi, "")
          .replace(/(href\s*=\s*)(["'])([^"']+)\2/i, (_m, attr, q, href) => `${attr}${q}${toProxyUrl(href)}${q}`);
      });

      // Make all remaining relative src= absolute so images/fonts load from the bot server
      // without needing a <base href> (which would break our relative proxy URLs above)
      html = html.replace(
        /(\bsrc\s*=\s*)(["'])(?!data:|https?:\/\/|\/\/|\/api\/)([^"']+)\2/gi,
        (_m, attr, q, src) => `${attr}${q}${toAbsUrl(src)}${q}`,
      );

      // Inject an ES module importmap so Vite dynamic chunk imports (e.g. import('/chunk.js'))
      // are redirected through our proxy instead of hitting our backend root unauthenticated.
      // Scope is limited to modules loaded from our proxy URL so it doesn't affect other imports.
      const botOrigin = new URL(finalUrl).origin;
      const encodedBase = encodeURIComponent(`${botOrigin}/`);
      const proxyBase = token
        ? `/api/tg-client/miniapp-proxy?token=${encodeURIComponent(token)}&url=${encodedBase}`
        : `/api/tg-client/miniapp-proxy?url=${encodedBase}`;
      const importMap = JSON.stringify({
        scopes: {
          "/api/tg-client/miniapp-proxy": {
            "/": proxyBase,
            [`${botOrigin}/`]: proxyBase,
          },
        },
      });
      const importMapTag = `<script type="importmap">${importMap}</script>`;
      // Must appear before any <script type="module">
      if (/<script\b[^>]*type\s*=\s*["']module["']/i.test(html)) {
        html = html.replace(
          /<script\b[^>]*type\s*=\s*["']module["']/i,
          `${importMapTag}\n$&`,
        );
      } else {
        html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${importMapTag}`);
      }

      res.send(html);
    } else {
      const buf = await upstream.arrayBuffer();
      res.send(Buffer.from(buf));
    }
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// GET /:accountId/folders
router.get("/:accountId/folders", async (req, res) => {
  const accountId = Number(req.params.accountId);
  try {
    const entry = await getLiveClient(accountId);
    res.json(await getFolders(entry));
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/dialogs?limit=
router.get("/:accountId/dialogs", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const limit = Math.min(Number(req.query.limit ?? 200), 200);
  try {
    const entry = await getLiveClient(accountId);
    const cached = getCachedDialogs(accountId);
    if (cached.length > 0) {
      res.json(cached);
      // Refresh in background and push updates via WebSocket
      syncDialogsInBackground(accountId).catch(() => {});
      return;
    }
    const dialogs = await loadDialogs(entry, limit);
    cacheDialogs(accountId, dialogs);
    res.json(dialogs);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/messages/:chatId?limit=50&offsetId=0&fresh=1
router.get("/:accountId/messages/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = req.params.chatId;
  const limit = Math.min(Number(req.query.limit ?? 50), 100);
  const offsetId = Number(req.query.offsetId ?? 0);
  const fresh = req.query.fresh === "1"; // bypass cache when true
  try {
    const entry = await getLiveClient(accountId);

    if (offsetId === 0 && !fresh) {
      // Initial load: serve from cache instantly, sync new messages in the background
      const cached = getCachedMessages(accountId, chatId, limit);
      if (cached.length > 0) {
        res.json(cached);
        syncMessagesInBackground(accountId, chatId).catch(() => {});
        return;
      }
    } else if (offsetId !== 0) {
      // Pagination: serve from cache if it covers a full page
      const cached = getCachedMessages(accountId, chatId, limit, offsetId);
      if (cached.length >= limit) {
        res.json(cached);
        return;
      }
    }

    const msgs = await getMessages(entry, chatId, limit, offsetId);
    cacheMessages(accountId, chatId, msgs);
    res.json(msgs);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/chats/:chatId/pinned -- fetch the pinned message for a group/channel
router.get("/:accountId/chats/:chatId/pinned", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  try {
    const entry = await getLiveClient(accountId);
    const msg = await getPinnedMessage(entry, chatId);
    res.json(msg ?? null);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// DELETE /:accountId/messages/:chatId/cache -- clear the local message cache for a chat
router.delete("/:accountId/messages/:chatId/cache", (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  clearCachedMessages(accountId, chatId);
  res.json({ ok: true });
});

// POST /:accountId/messages/:chatId -- send a message
router.post("/:accountId/messages/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = req.params.chatId;
  const { text, replyToMsgId } = req.body as {
    text?: string;
    replyToMsgId?: number;
  };
  if (!text?.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  try {
    const entry = await getLiveClient(accountId);
    const result = await sendMessage(
      entry,
      chatId,
      text.trim(),
      replyToMsgId ? Number(replyToMsgId) : undefined,
    );
    // Cache immediately -- GramJS won't fire NewMessage for UpdateShortSentMessage responses
    cacheMessages(accountId, chatId, [
      {
        id: result.id,
        text: text.trim(),
        html: null,
        date: result.date,
        fromMe: true,
        fromId: null,
        fromName: null,
        hasPhoto: false,
        hasDocument: false,
        buttons: null,
        reactions: null,
        replyToId: replyToMsgId ? Number(replyToMsgId) : null,
        replyToText: null,
        replyToName: null,
        replyCount: null,
      },
    ]);
    res.json(result);
    // Poll for bot replies at 1.5 s, 4 s, and 9 s after sending.
    // GramJS NewMessage fires for incoming messages; this is the fallback for any it misses.
    for (const delay of [1500, 4000, 9000]) {
      setTimeout(() => {
        syncMessagesInBackground(accountId, chatId).catch(() => {});
      }, delay);
    }
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/contacts
router.get("/:accountId/contacts", async (req, res) => {
  const accountId = Number(req.params.accountId);
  try {
    const entry = await getLiveClient(accountId);
    const contacts = await getContacts(entry);
    res.json(contacts);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/contacts -- add by phone number
router.post("/:accountId/contacts", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const { phone, firstName, lastName } = req.body as {
    phone?: string;
    firstName?: string;
    lastName?: string;
  };
  if (!phone || !firstName) {
    res.status(400).json({ error: "phone and firstName are required" });
    return;
  }
  try {
    const entry = await getLiveClient(accountId);
    const contact = await addContact(entry, phone, firstName, lastName ?? "");
    if (!contact) {
      res.status(404).json({ error: "Phone number not found on Telegram" });
      return;
    }
    res.json(contact);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/search?q=
router.get("/:accountId/search", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const q = String(req.query.q ?? "").trim();
  if (!q) {
    res.json([]);
    return;
  }
  try {
    const entry = await getLiveClient(accountId);
    const results = await searchPeers(entry, q);
    res.json(results);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/mute/:chatId -- mute (muteSecs>0) or unmute (muteSecs=0)
router.post("/:accountId/mute/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  const { muteSecs = 0 } = req.body as { muteSecs?: number };
  try {
    const entry = await getLiveClient(accountId);
    await muteDialog(entry, chatId, Number(muteSecs));
    res.json({ ok: true });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/pin/:chatId -- pin or unpin
router.post("/:accountId/pin/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  const { pinned = true } = req.body as { pinned?: boolean };
  try {
    const entry = await getLiveClient(accountId);
    await pinDialog(entry, chatId, Boolean(pinned));
    res.json({ ok: true });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/avatar/:chatId -- profile photo (single)
router.get("/:accountId/avatar/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  try {
    const entry = await getLiveClient(accountId);
    const buf = await fetchAvatar(entry, chatId);
    if (!buf) {
      res.set("Cache-Control", "public, max-age=3600");
      res.status(404).end();
      return;
    }
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch {
    res.set("Cache-Control", "public, max-age=3600");
    res.status(404).end();
  }
});

// GET /:accountId/avatars?ids=chatId1,chatId2,... -- batch profile photos
// Returns { [chatId]: base64String } for chats that have an avatar.
router.get("/:accountId/avatars", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const idsParam = (req.query.ids as string) ?? "";
  const chatIds = idsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 300);
  try {
    const entry = await getLiveClient(accountId);
    const result = await fetchAvatarsBatch(entry, chatIds);
    res.set("Cache-Control", "public, max-age=3600");
    res.json(result);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/profile/:chatId -- full entity details
router.get("/:accountId/profile/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  try {
    const entry = await getLiveClient(accountId);
    res.json(await getEntityDetails(entry, chatId));
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/messages/:chatId/:msgId/button -- trigger inline keyboard callback
router.post("/:accountId/messages/:chatId/:msgId/button", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  const msgId = Number(req.params.msgId);
  const { data } = req.body as { data?: string };
  if (!data) {
    res.status(400).json({ error: "data is required" });
    return;
  }
  try {
    const entry = await getLiveClient(accountId);
    const result = await clickButton(entry, chatId, msgId, data);
    res.json(result);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/messages/:chatId/:msgId/reaction -- send or remove a reaction
router.post(
  "/:accountId/messages/:chatId/:msgId/reaction",
  async (req, res) => {
    const accountId = Number(req.params.accountId);
    const chatId = decodeURIComponent(req.params.chatId);
    const msgId = Number(req.params.msgId);
    const { emoji } = req.body as { emoji?: string | null };
    try {
      const entry = await getLiveClient(accountId);
      await sendReaction(entry, chatId, msgId, emoji ?? null);
      res.json({ ok: true });
    } catch (err: any) {
      tgError(err, accountId, res);
    }
  },
);

// GET /:accountId/messages/:chatId/:msgId/thread -- replies / comments for a message
router.get("/:accountId/messages/:chatId/:msgId/thread", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  const msgId = Number(req.params.msgId);
  const limit = Math.min(Number(req.query.limit ?? 50), 100);
  const offsetId = Number(req.query.offsetId ?? 0);
  try {
    const entry = await getLiveClient(accountId);
    const msgs = await getThreadMessages(entry, chatId, msgId, limit, offsetId);
    res.json(msgs);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/messages/:chatId/:msgId/photo -- fetch photo for a message
router.get("/:accountId/messages/:chatId/:msgId/photo", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = req.params.chatId;
  const msgId = Number(req.params.msgId);
  try {
    const entry = await getLiveClient(accountId);
    const buf = await fetchPhoto(entry, chatId, msgId);
    if (!buf) {
      res.status(404).json({ error: "Photo not found" });
      return;
    }
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "private, max-age=3600");
    res.send(buf);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/reconnect -- disconnect and reconnect a live client
router.post("/:accountId/reconnect", async (req, res) => {
  const accountId = Number(req.params.accountId);
  try {
    await reconnectClient(accountId);
    res.json({ ok: true });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/invite/:hash -- preview a t.me/+ invite link
router.get("/:accountId/invite/:hash", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const hash = req.params.hash;
  try {
    const entry = await getLiveClient(accountId);
    const preview = await checkInvite(entry, hash);
    res.json(preview);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/invite/:hash -- join via invite link
router.post("/:accountId/invite/:hash", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const hash = req.params.hash;
  try {
    const entry = await getLiveClient(accountId);
    const dialog = await joinInvite(entry, hash);
    res.json(dialog);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/resolve-peer -- resolve a t.me username to a dialog object
router.post("/:accountId/resolve-peer", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const { username } = req.body as { username?: string };
  if (!username) {
    res.status(400).json({ error: "username is required" });
    return;
  }
  try {
    const entry = await getLiveClient(accountId);
    const dialog = await resolvePeer(entry, username);
    if (!dialog) {
      res.status(404).json({ error: "Peer not found" });
      return;
    }
    res.json(dialog);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/mark-read/:chatId -- mark messages as read up to maxId
router.post("/:accountId/mark-read/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  const { maxId } = req.body as { maxId?: number };
  if (!maxId) {
    res.status(400).json({ error: "maxId is required" });
    return;
  }
  try {
    const entry = await getLiveClient(accountId);
    await markRead(entry, chatId, Number(maxId));
    res.json({ ok: true });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/bot-commands/:chatId -- commands for a bot chat
router.get("/:accountId/bot-commands/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  try {
    const entry = await getLiveClient(accountId);
    res.json(await getBotCommands(entry, chatId));
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/join/:chatId -- join a public channel or supergroup
// POST /:accountId/webview/resolve -- resolve a mini app URL to an authenticated web app URL
router.post("/:accountId/webview/resolve", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const { url, botChatId } = req.body as { url: string; botChatId?: string };
  if (!url) {
    res.status(400).json({ error: "url required" });
    return;
  }
  try {
    const entry = await getLiveClient(accountId);
    const webAppUrl = await resolveWebApp(entry, url, botChatId);
    res.json({ webAppUrl });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/membership/:chatId -- check if user is currently a member
router.get("/:accountId/membership/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  try {
    const entry = await getLiveClient(accountId);
    const isMember = await checkMembership(entry, chatId);
    res.json({ member: isMember });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

router.post("/:accountId/join/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  try {
    const entry = await getLiveClient(accountId);
    const result = await joinChannel(entry, chatId);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// POST /:accountId/start-bot/:username -- open bot and send startParam (t.me/bot?start=PARAM)
router.post("/:accountId/start-bot/:username", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const username = req.params.username;
  const { startParam } = req.body as { startParam: string };
  try {
    const entry = await getLiveClient(accountId);
    const dialog = await startBot(entry, username, startParam);
    res.json(dialog);
  } catch (err: any) {
    tgError(err, accountId, res);
  }
});

// GET /:accountId/events -- SSE stream for real-time messages
router.get("/:accountId/events", async (req, res) => {
  const accountId = Number(req.params.accountId);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":\n\n");

  const send = (data: object) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Ensure client is alive so the event handler is registered
    await getLiveClient(accountId);

    const heartbeat = setInterval(() => res.write(":\n\n"), 25_000);

    const unsubscribe = subscribeToMessages(accountId, (msg) => {
      send({ type: "message", ...msg });
    });

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  } catch (err: any) {
    send({ type: "error", error: err.message });
    res.end();
  }
});

export default router;
