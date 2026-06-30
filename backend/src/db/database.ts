import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH =
  process.env.DB_PATH ?? path.resolve(process.cwd(), "data/bemby.db");

const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS tg_accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    phone_number TEXT   NOT NULL,
    api_id      INTEGER NOT NULL,
    api_hash    TEXT    NOT NULL,
    session_string TEXT,
    auth_status TEXT    NOT NULL DEFAULT 'unauthenticated',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT    NOT NULL,
    account_id            INTEGER NOT NULL REFERENCES tg_accounts(id) ON DELETE CASCADE,
    job_type              TEXT    NOT NULL DEFAULT 'checkin',
    bot_username          TEXT    NOT NULL,
    schedule_window_start INTEGER NOT NULL DEFAULT 1400,
    schedule_window_end   INTEGER NOT NULL DEFAULT 1600,
    timezone              TEXT    NOT NULL DEFAULT 'Australia/Sydney',
    reply_timeout_ms      INTEGER NOT NULL DEFAULT 40000,
    retry_max             INTEGER NOT NULL DEFAULT 5,
    enabled               INTEGER NOT NULL DEFAULT 1,
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS job_logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id  INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    ran_at  TEXT    NOT NULL,
    status  TEXT    NOT NULL,
    message TEXT,
    source  TEXT    NOT NULL DEFAULT 'scheduler'
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  INSERT OR IGNORE INTO settings (key, value) VALUES
    ('default_timezone',     'Australia/Sydney'),
    ('default_max_retry',    '5'),
    ('check_daily_run',      'true'),
    ('default_ua',           'SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0'),
    ('default_play_duration','300'),
    ('default_device_name',  'Mac'),
    ('ai_base_url',          'https://openrouter.ai/api/v1'),
    ('ai_api_key',           ''),
    ('ai_model',             'nvidia/nemotron-nano-12b-v2-vl:free'),
    ('ai_timeout_ms',        '25000'),
    ('ua_presets',           '[{"name":"SenPlayer (Mac)","value":"SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0"},{"name":"Yamby (Android TV)","value":"Yamby/2.0.3.4(Android)"},{"name":"Hills (Windows)","value":"Hills/0.2.1"},{"name":"Lenna (iOS)","value":"Lenna/1.0.15 CFNetwork/1494.0.7 Darwin/23.4.0"},{"name":"VidHub (iOS)","value":"VidHub/2.2.4"}]');
`);

// Seed ua_presets for existing installs that pre-date this setting
try {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(
    "ua_presets",
    '[{"name":"SenPlayer (Mac)","value":"SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0"},{"name":"Yamby (Android TV)","value":"Yamby/2.0.3.4(Android)"},{"name":"Hills (Windows)","value":"Hills/0.2.1"},{"name":"Lenna (iOS)","value":"Lenna/1.0.15 CFNetwork/1494.0.7 Darwin/23.4.0"},{"name":"VidHub (iOS)","value":"VidHub/2.2.4"}]',
  );
} catch {}

// Migrations for columns added after initial schema
try {
  db.exec(
    "ALTER TABLE job_logs ADD COLUMN source TEXT NOT NULL DEFAULT 'scheduler'",
  );
} catch {}
try {
  db.exec("ALTER TABLE jobs ADD COLUMN config TEXT");
} catch {}
try {
  db.exec(
    "UPDATE settings SET value = 'Yamby' WHERE key = 'default_device_name' AND value = 'tg-runner'",
  );
} catch {}
try {
  db.exec(
    "UPDATE settings SET value = 'Mac' WHERE key = 'default_device_name' AND value = 'Yamby'",
  );
} catch {}
try {
  db.exec(
    "UPDATE settings SET value = 'SenPlayer/6.1.0 CFNetwork/1490.0.4 Darwin/23.2.0' WHERE key = 'default_ua' AND value = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'",
  );
} catch {}
try {
  db.exec(
    "UPDATE settings SET value = 'SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0' WHERE key = 'default_ua' AND value = 'SenPlayer/6.1.0 CFNetwork/1490.0.4 Darwin/23.2.0'",
  );
} catch {}
// Overwrite placeholder preset values written before correct UAs were researched
try {
  db.prepare(
    "UPDATE settings SET value = ? WHERE key = 'ua_presets' AND (value LIKE '%ExoPlayerLib%' OR value LIKE '%VidHub/2.1.0%')",
  ).run(
    '[{"name":"SenPlayer (Mac)","value":"SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0"},{"name":"Yamby (Android TV)","value":"Yamby/2.0.3.4(Android)"},{"name":"Hills (Windows)","value":"Hills/0.2.1"},{"name":"Lenna (iOS)","value":"Lenna/1.0.15 CFNetwork/1494.0.7 Darwin/23.4.0"},{"name":"VidHub (iOS)","value":"VidHub/2.2.4"}]',
  );
} catch {}
try {
  db.exec(
    "ALTER TABLE jobs ADD COLUMN start_command TEXT NOT NULL DEFAULT '/start'",
  );
} catch {}
try {
  db.exec(
    "ALTER TABLE jobs ADD COLUMN checkin_button TEXT NOT NULL DEFAULT '签到'",
  );
} catch {}
try {
  db.exec("ALTER TABLE job_logs ADD COLUMN detail TEXT");
} catch {}
try {
  db.exec("ALTER TABLE job_logs ADD COLUMN retired INTEGER NOT NULL DEFAULT 0");
} catch {}
try {
  db.exec(
    "ALTER TABLE jobs ADD COLUMN template_id INTEGER REFERENCES job_templates(id) ON DELETE SET NULL",
  );
} catch {}
try {
  db.exec("ALTER TABLE tg_accounts ADD COLUMN proxy_id TEXT");
} catch {}
try {
  db.exec(
    "ALTER TABLE tg_accounts ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0",
  );
} catch {}
try {
  db.exec("ALTER TABLE tg_accounts ADD COLUMN app_client_id TEXT");
} catch {}
try {
  db.exec(
    "ALTER TABLE tg_accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
  );
} catch {}
try {
  db.exec("UPDATE tg_accounts SET sort_order = id WHERE sort_order = 0");
} catch {}
try {
  db.exec("ALTER TABLE jobs ADD COLUMN run_every_days INTEGER NOT NULL DEFAULT 1");
} catch {}
try {
  db.exec("ALTER TABLE job_templates ADD COLUMN run_every_days INTEGER NOT NULL DEFAULT 1");
} catch {}
try {
  db.exec("ALTER TABLE tg_accounts ADD COLUMN tg_display_name TEXT");
} catch {}
try {
  db.exec("ALTER TABLE tg_accounts ADD COLUMN tg_username TEXT");
} catch {}

// Seed default TG app client profiles (Linux is default)
try {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(
    "tg_app_clients",
    JSON.stringify([
      {
        id: "preset-ios",
        name: "iOS",
        deviceModel: "iPhone 13 Pro Max",
        systemVersion: "iOS 15.4.1",
        appVersion: "8.4.2",
        langCode: "en",
        langPack: "ios",
        systemLangCode: "en-US",
        isDefault: false,
      },
      {
        id: "preset-android",
        name: "Android",
        deviceModel: "Samsung SM-G991B",
        systemVersion: "Android 12",
        appVersion: "9.1.1",
        langCode: "en",
        langPack: "android",
        systemLangCode: "en-US",
        isDefault: false,
      },
      {
        id: "preset-windows",
        name: "Windows",
        deviceModel: "Desktop",
        systemVersion: "Windows 10",
        appVersion: "4.16.5",
        langCode: "en",
        langPack: "tdesktop",
        systemLangCode: "en-US",
        isDefault: false,
      },
      {
        id: "preset-mac",
        name: "Mac",
        deviceModel: "MacBook Pro",
        systemVersion: "macOS 13.2",
        appVersion: "8.4.2",
        langCode: "en",
        langPack: "macos",
        systemLangCode: "en-US",
        isDefault: false,
      },
      {
        id: "preset-linux",
        name: "Linux",
        deviceModel: "PC 64bit",
        systemVersion: "Ubuntu 22.04 LTS",
        appVersion: "4.16.5",
        langCode: "en",
        langPack: "tdesktop",
        systemLangCode: "en-US",
        isDefault: true,
      },
    ]),
  );
} catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS job_templates (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    job_type         TEXT    NOT NULL DEFAULT 'checkin',
    bot_username     TEXT    NOT NULL DEFAULT '',
    timezone         TEXT    NOT NULL DEFAULT 'Australia/Sydney',
    reply_timeout_ms INTEGER NOT NULL DEFAULT 40000,
    retry_max        INTEGER NOT NULL DEFAULT 5,
    enabled          INTEGER NOT NULL DEFAULT 1,
    config           TEXT,
    start_command    TEXT    NOT NULL DEFAULT '/start',
    checkin_button   TEXT    NOT NULL DEFAULT '签到',
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// AI supplier + model tables
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_suppliers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    base_url   TEXT    NOT NULL,
    api_key    TEXT    NOT NULL DEFAULT '',
    timeout_ms INTEGER NOT NULL DEFAULT 25000
  );
  CREATE TABLE IF NOT EXISTS ai_models (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL REFERENCES ai_suppliers(id) ON DELETE CASCADE,
    model_id    TEXT    NOT NULL,
    label       TEXT
  );
`);

// Seed default OpenRouter supplier on first run; carry over any legacy flat-settings values for upgrades
try {
  const supplierCount = (
    db.prepare("SELECT COUNT(*) AS n FROM ai_suppliers").get() as { n: number }
  ).n;
  if (supplierCount === 0) {
    const getSetting = (key: string) =>
      (
        db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
          | { value: string }
          | undefined
      )?.value ?? "";
    const apiKey = getSetting("ai_api_key");
    const baseUrl = getSetting("ai_base_url") || "https://openrouter.ai/api/v1";
    const model =
      getSetting("ai_model") || "nvidia/nemotron-nano-12b-v2-vl:free";
    const timeout = getSetting("ai_timeout_ms");
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO ai_suppliers (name, base_url, api_key, timeout_ms) VALUES (?, ?, ?, ?)",
      )
      .run("OpenRouter", baseUrl, apiKey, Number(timeout) || 25000);
    db.prepare(
      "INSERT INTO ai_models (supplier_id, model_id) VALUES (?, ?)",
    ).run(lastInsertRowid, model);
  }
} catch (e) {
  console.error("[db] AI supplier seed failed:", e);
}

// Make account_id nullable so embywatch jobs don't require a Telegram account
try {
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  if (cols.find((c) => c.name === "account_id")?.notnull === 1) {
    db.exec(`
      DROP TABLE IF EXISTS jobs_v2;
      CREATE TABLE jobs_v2 (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        name                  TEXT    NOT NULL,
        account_id            INTEGER REFERENCES tg_accounts(id) ON DELETE SET NULL,
        job_type              TEXT    NOT NULL DEFAULT 'checkin',
        bot_username          TEXT    NOT NULL,
        schedule_window_start INTEGER NOT NULL DEFAULT 1400,
        schedule_window_end   INTEGER NOT NULL DEFAULT 1600,
        timezone              TEXT    NOT NULL DEFAULT 'Australia/Sydney',
        reply_timeout_ms      INTEGER NOT NULL DEFAULT 40000,
        retry_max             INTEGER NOT NULL DEFAULT 5,
        enabled               INTEGER NOT NULL DEFAULT 1,
        created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
        config                TEXT,
        start_command         TEXT    NOT NULL DEFAULT '/start',
        checkin_button        TEXT    NOT NULL DEFAULT '签到',
        template_id           INTEGER REFERENCES job_templates(id) ON DELETE SET NULL,
        run_every_days        INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO jobs_v2 SELECT * FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_v2 RENAME TO jobs;
    `);
    console.log("[db] Migrated jobs.account_id to nullable");
  }
} catch (e) {
  console.error("[db] account_id migration failed:", e);
}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tg_message_cache (
      account_id INTEGER NOT NULL,
      chat_id    TEXT    NOT NULL,
      msg_id     INTEGER NOT NULL,
      msg_date   INTEGER NOT NULL,
      payload    TEXT    NOT NULL,
      PRIMARY KEY (account_id, chat_id, msg_id)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tgmc ON tg_message_cache(account_id, chat_id, msg_id DESC)`,
  );
} catch {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tg_dialog_cache (
      account_id INTEGER NOT NULL,
      chat_id    TEXT    NOT NULL,
      sort_order INTEGER NOT NULL,
      payload    TEXT    NOT NULL,
      PRIMARY KEY (account_id, chat_id)
    )
  `);
} catch {}
