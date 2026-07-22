import { Router } from "express";
import { db } from "../db/database";
import { refreshScheduler, purgeOldLogs } from "../scheduler";
import { SocksClient } from "socks";
import { parseTgProxy } from "../jobs/runner";
import { isBulkAccountManagementEnabled } from "../jobs/bulkAdd";

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
  "ai_default_model_id",
  "ai_fallback_enabled",
  "notify_tg_username",
  "notify_tg_events",
  "ua_presets",
  "proxies",
  "tg_app_clients",
  "tg_client_mode",
  "default_tg_api_id",
  "default_tg_api_hash",
  "account_display_with_tg_name",
  "log_retention_days",
  "schedule_min_gap_minutes",
];

/** Settings keys that must never be sent to the client. */
export const CLIENT_HIDDEN_KEYS = new Set([
  "admin_password_hash",
  "admin_username",
  "jwt_secret",
  // Legacy single-key AI credential (superseded by the ai_suppliers table);
  // never echo it back to the client on upgraded installs.
  "ai_api_key",
]);

/** True when an AI key exists anywhere the runtime looks: a supplier, the legacy setting or the env. */
function aiKeyConfigured(): boolean {
  const suppliers = db
    .prepare("SELECT COUNT(*) AS n FROM ai_suppliers WHERE api_key != ''")
    .get() as { n: number };
  if (suppliers.n > 0) return true;
  const legacy = db
    .prepare("SELECT value FROM settings WHERE key = 'ai_api_key'")
    .get() as { value: string } | undefined;
  return Boolean(legacy?.value || process.env.AI_API_KEY);
}

/** Returns first 4 chars + **** + last 4 chars, or **** for short values. */
function maskApiHash(hash: string): string {
  if (!hash) return "";
  if (hash.length <= 8) return "****";
  return `${hash.slice(0, 4)}****${hash.slice(-4)}`;
}

/** Returns client-safe settings: migration flags and secret keys removed, API hash masked. */
function getClientSettings(): Record<string, string> {
  const rows = db
    .prepare("SELECT key, value FROM settings WHERE key NOT LIKE 'migration:%'")
    .all() as SettingRow[];
  const result = Object.fromEntries(
    rows.filter((r) => !CLIENT_HIDDEN_KEYS.has(r.key)).map((r) => [r.key, r.value]),
  );
  // Never expose the raw hash to the client
  if (result.default_tg_api_hash) {
    result.default_tg_api_hash = maskApiHash(result.default_tg_api_hash);
  }
  // Synthetic flag so the client can gate AI features without seeing the key
  result.ai_key_configured = aiKeyConfigured() ? "true" : "false";
  // Env-gated feature flag for bulk account management (add + clean)
  result.bulk_account_management = isBulkAccountManagementEnabled()
    ? "true"
    : "false";
  return result;
}

router.get("/", (_req, res) => {
  res.json(getClientSettings());
});

router.put("/", (req, res) => {
  const updates = req.body as Record<string, string>;
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
  );

  db.transaction(() => {
    for (const key of ALLOWED_KEYS) {
      if (!(key in updates)) continue;
      // Skip if the client sent back the masked hash unchanged
      if (
        key === "default_tg_api_hash" &&
        String(updates[key]).includes("****")
      )
        continue;
      stmt.run(key, String(updates[key]));
    }
  })();

  // Reschedule if daily-run check toggled or the default timezone changed
  // (jobs with no timezone of their own follow the default)
  if ("check_daily_run" in updates || "default_timezone" in updates)
    refreshScheduler();

  // Apply a tightened retention window straight away
  if ("log_retention_days" in updates) purgeOldLogs();

  res.json(getClientSettings());
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
