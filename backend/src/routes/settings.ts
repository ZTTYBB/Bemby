import { Router } from "express";
import { db } from "../db/database";
import { refreshScheduler } from "../scheduler";
import { SocksClient } from "socks";
import { parseTgProxy } from "../jobs/runner";

const router = Router();

type SettingRow = { key: string; value: string };

export const ALLOWED_KEYS = [
  "default_timezone",
  "default_max_retry",
  "check_daily_run",
  "default_ua",
  "default_play_duration",
  "default_device_name",
  "ai_model",
  "notify_tg_username",
  "notify_tg_events",
  "ua_presets",
  "proxies",
  "tg_app_clients",
  "tg_client_mode",
];

router.get("/", (_req, res) => {
  const rows = db
    .prepare("SELECT key, value FROM settings")
    .all() as SettingRow[];
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

router.put("/", (req, res) => {
  const updates = req.body as Record<string, string>;
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
  );

  db.transaction(() => {
    for (const key of ALLOWED_KEYS) {
      if (key in updates) stmt.run(key, String(updates[key]));
    }
  })();

  // Reschedule if daily-run check toggled
  if ("check_daily_run" in updates) refreshScheduler();

  const rows = db
    .prepare("SELECT key, value FROM settings")
    .all() as SettingRow[];
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

// Test TCP reachability through a SOCKS proxy (target: 1.1.1.1:80)
router.post("/test-proxy", async (req, res) => {
  const { url } = req.body as { url?: string };
  if (!url) {
    res.status(400).json({ error: "url is required" });
    return;
  }

  const proxy = parseTgProxy(url);
  if (!proxy) {
    res
      .status(400)
      .json({ error: "Invalid proxy URL — use socks5:// or socks4://" });
    return;
  }

  try {
    const result = await SocksClient.createConnection({
      proxy: {
        host: proxy.ip,
        port: proxy.port,
        type: proxy.socksType,
        ...(proxy.username
          ? { userId: proxy.username, password: proxy.password }
          : {}),
      },
      command: "connect",
      destination: { host: "1.1.1.1", port: 80 },
      timeout: 6000,
    });
    result.socket.destroy();
    res.json({ ok: true });
  } catch (err: any) {
    res.json({ ok: false, error: err.message ?? "Connection failed" });
  }
});

export default router;
