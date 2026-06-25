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
  subscribeToMessages,
  getFolders,
} from "../tg/liveClient";

const router = Router();

// GET /:accountId/folders
router.get("/:accountId/folders", async (req, res) => {
  const accountId = Number(req.params.accountId);
  try {
    const entry = await getLiveClient(accountId);
    res.json(await getFolders(entry));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:accountId/dialogs
router.get("/:accountId/dialogs", async (req, res) => {
  const accountId = Number(req.params.accountId);
  try {
    const entry = await getLiveClient(accountId);
    const dialogs = await loadDialogs(entry);
    res.json(dialogs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:accountId/messages/:chatId?limit=50&offsetId=0
router.get("/:accountId/messages/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = req.params.chatId;
  const limit = Math.min(Number(req.query.limit ?? 50), 100);
  const offsetId = Number(req.query.offsetId ?? 0);
  try {
    const entry = await getLiveClient(accountId);
    const msgs = await getMessages(entry, chatId, limit, offsetId);
    res.json(msgs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
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
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// GET /:accountId/avatar/:chatId -- profile photo
router.get("/:accountId/avatar/:chatId", async (req, res) => {
  const accountId = Number(req.params.accountId);
  const chatId = decodeURIComponent(req.params.chatId);
  try {
    const entry = await getLiveClient(accountId);
    const buf = await fetchAvatar(entry, chatId);
    if (!buf) {
      res.status(404).end();
      return;
    }
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch {
    res.status(404).end();
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
