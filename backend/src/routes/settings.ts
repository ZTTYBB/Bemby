import { Router } from "express";
import { db } from "../db/database";
import { refreshScheduler, purgeOldLogs } from "../scheduler";
import { SocksClient } from "socks";
import { parseTgProxy } from "../jobs/runner";
import { isBulkAccountManagementEnabled } from "../jobs/bulkAdd";
import {
  areCfFontsInstalled,
  cfFontsStatus,
  chromiumVersion,
  installCfChromium,
  installCfFonts,
  isChromiumInstalled,
  testBrowser,
} from "../jobs/cloudflare";
import {
  CF_TUNING_DEFAULTS,
  CF_TUNING_KEY,
  CF_TUNING_LIMITS,
  cfTuning,
  invalidateCfTuning,
  resolveCfTuning,
} from "../jobs/cfTuning";
import {
  CF_KEYS_SETTING,
  cfLicenseKeys,
  cfLicenseKeysForClient,
  cfLicenseUsage,
  maskKey,
  saveCfLicenseKeys,
} from "../jobs/cfLicense";
import { checkCfLicenseKey } from "../jobs/cfBrowser";
import {
  providersForClient,
  saveProviders,
  syncProviders,
  type ProxyProvider,
} from "../tg/proxyProviders";

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
  "cf_solver_enabled",
  CF_TUNING_KEY,
];

/** Settings keys that must never be sent to the client. */
export const CLIENT_HIDDEN_KEYS = new Set([
  "admin_password_hash",
  "admin_username",
  "jwt_secret",
  // Legacy single-key AI credential (superseded by the ai_suppliers table);
  // never echo it back to the client on upgraded installs.
  "ai_api_key",
  // CloakBrowser licence keys: served separately, masked
  CF_KEYS_SETTING,
  // Proxy provider credentials: served separately, with keys replaced by a flag
  "webshare_api_key",
  "proxy_providers",
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
  // Whether the on-demand Cloudflare-solver browser is present, and which build
  result.cf_chromium_installed = isChromiumInstalled() ? "true" : "false";
  result.cf_chromium_version = chromiumVersion() ?? "";
  // The CJK/emoji faces are not in the image either; they sit beside the browser in the
  // data dir. Reported separately so a browser that can only draw Latin is visible.
  result.cf_fonts_installed = areCfFontsInstalled() ? "true" : "false";
  result.cf_fonts_missing = cfFontsStatus().missing.join(", ");
  // Licence keys, masked, plus how many seats are taken right now: a free key is one
  // concurrent session, so the count is what tells the operator whether to add another
  result.cf_cloak_keys_masked = JSON.stringify(cfLicenseKeysForClient());
  result.cf_cloak_keys_in_use = String(cfLicenseUsage().inUse);
  // The browser timings in force, alongside the shipped defaults and the range each is
  // held to, so the client can render every field without a second source of truth
  result.cf_tuning = JSON.stringify(cfTuning());
  result.cf_tuning_defaults = JSON.stringify(CF_TUNING_DEFAULTS);
  result.cf_tuning_limits = JSON.stringify(CF_TUNING_LIMITS);
  // Synthetic count so the client can show whether proxy importing is set up
  result.proxy_providers_count = String(providersForClient().length);
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
      // Browser timings are stored resolved: out-of-range or unparsable values become the
      // shipped default there and then, so what is saved is what a job will use
      if (key === CF_TUNING_KEY) {
        let incoming: unknown = updates[key];
        if (typeof incoming === "string") {
          try {
            incoming = JSON.parse(incoming);
          } catch {
            incoming = undefined;
          }
        }
        stmt.run(key, JSON.stringify(resolveCfTuning(incoming)));
        continue;
      }
      stmt.run(key, String(updates[key]));
    }
  })();

  // Reschedule if daily-run check toggled or the default timezone changed
  // (jobs with no timezone of their own follow the default)
  if ("check_daily_run" in updates || "default_timezone" in updates)
    refreshScheduler();

  // Apply a tightened retention window straight away
  if ("log_retention_days" in updates) purgeOldLogs();

  // Drop the cached timings so the next job picks the new ones up without a restart
  if (CF_TUNING_KEY in updates) invalidateCfTuning();

  res.json(getClientSettings());
});

// POST /cf-solver/install -- download the CloakBrowser stealth Chromium (~200MB) and the
// CJK/emoji faces (~30MB) on demand into the data dir so the Cloudflare "I am not a bot"
// solver can run. Neither is in the image, and the data dir is a volume, so both survive an
// upgrade. `force` downloads again over an existing install, which is how they get updated.
//
// The fonts are reported but do not decide `ok`: with the image's Latin fallback the
// browser still works, so a blocked font download is a warning, not a failed install.
let cfInstalling = false;
router.post("/cf-solver/install", async (req, res) => {
  const force = req.body?.force === true || req.query.force === "1";
  if (isChromiumInstalled() && areCfFontsInstalled() && !force) {
    res.json({
      ok: true,
      installed: true,
      fontsInstalled: true,
      version: chromiumVersion(),
      message: "Already installed",
    });
    return;
  }
  if (cfInstalling) {
    res.status(409).json({ ok: false, message: "Install already in progress" });
    return;
  }
  cfInstalling = true;
  try {
    // Only re-download a browser that is missing (or explicitly forced): an upgrade from an
    // image that carried the fonts needs the fonts alone, not another 200MB of browser.
    const browser = isChromiumInstalled() && !force
      ? { ok: true, output: "Browser already installed" }
      : await installCfChromium(force);
    const fonts = await installCfFonts(force);
    if (browser.ok) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cf_solver_enabled', 'true')").run();
    }
    res.json({
      ok: browser.ok,
      installed: browser.ok,
      fontsInstalled: fonts.ok,
      version: browser.ok ? chromiumVersion() : undefined,
      output: `${browser.output}\n\n--- fonts ---\n${fonts.output}`.slice(-1500),
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err?.message ?? "Install failed" });
  } finally {
    cfInstalling = false;
  }
});

// ── CloakBrowser licence keys ─────────────────────────────────────────────────
// A free key (one per GitHub sign-in at cloakbrowser.dev/free) gets the current stealth
// build instead of the ageing one that needs no key, and allows one concurrent browser.
// Several can be stored so concurrent jobs each get a seat. Never sent back in full.

router.get("/cf-solver/keys", (_req, res) => {
  res.json({ keys: cfLicenseKeysForClient(), ...cfLicenseUsage() });
});

router.put("/cf-solver/keys", (req, res) => {
  const { keys } = req.body as { keys?: Array<{ label?: string; key?: string }> };
  if (!Array.isArray(keys)) {
    res.status(400).json({ error: "keys array is required" });
    return;
  }
  saveCfLicenseKeys(keys);
  res.json({ keys: cfLicenseKeysForClient(), ...cfLicenseUsage() });
});

// POST /cf-solver/keys/check -- ask CloakBrowser's server what each stored key is worth,
// so a key that was mistyped or has lapsed shows up here rather than as a job that quietly
// runs the old build.
router.post("/cf-solver/keys/check", async (_req, res) => {
  const results = [];
  for (const entry of cfLicenseKeys()) {
    results.push({ label: entry.label, masked: maskKey(entry.key), ...(await checkCfLicenseKey(entry.key)) });
  }
  res.json({ results });
});

// POST /cf-solver/test -- launch the installed browser and check that it renders, so a
// Mini App step that comes up blank on a server can be told apart from a site problem.
// `?screenshot=1` includes what the browser drew.
router.post("/cf-solver/test", async (req, res) => {
  const result = await testBrowser();
  res.json(req.query.screenshot ? result : { ...result, screenshot: undefined });
});

// ── Proxy providers ───────────────────────────────────────────────────────────
// Configured proxy sellers whose current list can be pulled into the proxies setting.
// API keys are never sent back to the client; a `hasKey` flag stands in for them.

router.get("/proxy-providers", (_req, res) => {
  res.json({ providers: providersForClient() });
});

router.put("/proxy-providers", (req, res) => {
  const { providers } = req.body as { providers?: ProxyProvider[] };
  if (!Array.isArray(providers)) {
    res.status(400).json({ error: "providers array is required" });
    return;
  }

  const seen = new Set<string>();
  for (const p of providers) {
    if (!p?.id?.trim() || !p?.name?.trim()) {
      res.status(400).json({ error: "Each provider needs an id and a name" });
      return;
    }
    if (p.type !== "webshare" && p.type !== "list") {
      res.status(400).json({ error: `Unsupported provider type "${p.type}"` });
      return;
    }
    if (p.type === "list" && !p.url?.trim()) {
      res.status(400).json({ error: `"${p.name}" needs a list URL` });
      return;
    }
    if (seen.has(p.id)) {
      res.status(400).json({ error: "Provider ids must be unique" });
      return;
    }
    seen.add(p.id);
  }

  saveProviders(providers);
  res.json({ providers: providersForClient() });
});

// Pull the current lists in. `providerId` syncs a single provider; otherwise every
// enabled one is synced. Manual proxies, and imports from providers that were not
// synced, are preserved.
router.post("/proxy-providers/sync", async (req, res) => {
  const { providerId } = req.body as { providerId?: string };
  try {
    const result = await syncProviders(providerId?.trim() || undefined);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(502).json({ ok: false, error: err?.message ?? "Sync failed" });
  }
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
