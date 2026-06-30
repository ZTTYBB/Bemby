import { Router } from "express";
import { db } from "../db/database";
import {
  requestCode,
  submitCode,
  submitPassword,
  checkAccountStatus,
  resendCodeAsSms,
} from "../auth/tgAuth";
import { checkSpamStatus } from "../jobs/checkin";
import type { AuthStatus, TgAppClient } from "../types";
import type { TgDeviceParams } from "../auth/tgAuth";
import { parseTgProxy } from "../jobs/runner";
import { isAuthError, markSessionExpired } from "../tg/liveClient";

// Reasons set by checkAccountStatus for frozen/revoked sessions that need re-auth
const REAUTH_REASONS = new Set([
  "auth_key_duplicated",
  "session_revoked",
  "auth_key_unregistered",
  "account_frozen",
]);

function statusNeedsReauth(
  status: import("../auth/tgAuth").TgAccountStatus,
): boolean {
  return status.restrictions.some((r) =>
    REAUTH_REASONS.has(r.reason.toLowerCase()),
  );
}

const router = Router();

type AccountRow = {
  id: number;
  name: string;
  phone_number: string;
  api_id: number;
  api_hash: string;
  session_string: string | null;
  auth_status: AuthStatus;
  proxy_id: string | null;
  disabled: number;
  app_client_id: string | null;
  created_at: string;
  sort_order: number;
  tg_display_name: string | null;
  tg_username: string | null;
};

function resolveAppClientParams(
  appClientId: string | null | undefined,
): TgDeviceParams | undefined {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("tg_app_clients") as { value: string } | undefined;
    if (!row?.value) return undefined;
    const list = JSON.parse(row.value) as TgAppClient[];
    if (!list.length) return undefined;

    let client: TgAppClient | undefined;
    if (appClientId) {
      client = list.find((c) => c.id === appClientId);
    } else {
      const modeRow = db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get("tg_client_mode") as { value: string } | undefined;
      if (modeRow?.value === "random") {
        client = list[Math.floor(Math.random() * list.length)];
      } else {
        client = list.find((c) => c.isDefault);
      }
    }

    if (!client) return undefined;
    return {
      deviceModel: client.deviceModel,
      systemVersion: client.systemVersion,
      appVersion: client.appVersion,
      langCode: client.langCode,
      langPack: client.langPack,
      systemLangCode: client.systemLangCode,
    };
  } catch {
    return undefined;
  }
}

function resolveProxyUrl(
  proxyId: string | null | undefined,
): string | undefined {
  if (!proxyId) return undefined;
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("proxies") as { value: string } | undefined;
    if (!row?.value) return undefined;
    const list = JSON.parse(row.value) as Array<{ id: string; url: string }>;
    return list.find((p) => p.id === proxyId)?.url;
  } catch {
    return undefined;
  }
}

function toJson(row: AccountRow) {
  return {
    id: row.id,
    name: row.name,
    phoneNumber: row.phone_number,
    apiId: row.api_id,
    // apiHash intentionally omitted from responses
    authStatus: row.auth_status,
    proxyId: row.proxy_id ?? null,
    disabled: Boolean(row.disabled),
    appClientId: row.app_client_id ?? null,
    createdAt: row.created_at,
    sortOrder: row.sort_order ?? 0,
    tgDisplayName: row.tg_display_name ?? null,
    tgUsername: row.tg_username ?? null,
  };
}

function saveTgMeta(id: number, firstName: string, lastName: string | undefined, username: string | undefined) {
  const displayName = [firstName, lastName].filter(Boolean).join(" ");
  db.prepare(
    "UPDATE tg_accounts SET tg_display_name = ?, tg_username = ? WHERE id = ?",
  ).run(displayName || null, username || null, id);
}

router.get("/", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM tg_accounts ORDER BY sort_order, id")
    .all() as AccountRow[];
  res.json(rows.map(toJson));
});

router.post("/", (req, res) => {
  const { name, phoneNumber, apiId, apiHash, proxyId, appClientId } =
    req.body as Record<string, string>;
  if (!name || !phoneNumber || !apiId || !apiHash) {
    res
      .status(400)
      .json({ error: "name, phoneNumber, apiId, apiHash are required" });
    return;
  }

  const maxRow = db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM tg_accounts")
    .get() as { m: number };
  const result = db
    .prepare(
      "INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, proxy_id, app_client_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      name,
      phoneNumber,
      Number(apiId),
      apiHash,
      proxyId || null,
      appClientId || null,
      maxRow.m + 1,
    );

  const row = db
    .prepare("SELECT * FROM tg_accounts WHERE id = ?")
    .get(result.lastInsertRowid) as AccountRow;
  res.status(201).json(toJson(row));
});

// PUT /reorder -- update sort_order for multiple accounts at once
router.put("/reorder", (req, res) => {
  const { items } = req.body as {
    items?: Array<{ id: number; sortOrder: number }>;
  };
  if (!Array.isArray(items)) {
    res.status(400).json({ error: "items array required" });
    return;
  }
  const update = db.prepare(
    "UPDATE tg_accounts SET sort_order = ? WHERE id = ?",
  );
  const tx = db.transaction(() => {
    for (const { id, sortOrder } of items) update.run(sortOrder, id);
  });
  tx();
  res.json({ ok: true });
});

type AccountImportItem = {
  name?: string;
  phoneNumber: string;
  apiId: number;
  apiHash: string;
  sessionString?: string | null;
  authStatus?: string;
  proxyId?: string | null;
  appClientId?: string | null;
  disabled?: boolean;
};

// POST /export -- export selected (or all) accounts with sensitive fields
router.post("/export", (req, res) => {
  const { ids } = req.body as { ids?: number[] };
  let rows: AccountRow[];
  if (Array.isArray(ids) && ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    rows = db
      .prepare(
        `SELECT * FROM tg_accounts WHERE id IN (${placeholders}) ORDER BY id`,
      )
      .all(...ids) as AccountRow[];
  } else {
    rows = db
      .prepare("SELECT * FROM tg_accounts ORDER BY id")
      .all() as AccountRow[];
  }
  res.json({
    version: "1",
    exportedAt: new Date().toISOString(),
    accounts: rows.map((a) => ({
      name: a.name,
      phoneNumber: a.phone_number,
      apiId: a.api_id,
      apiHash: a.api_hash,
      sessionString: a.session_string,
      authStatus: a.auth_status,
      proxyId: a.proxy_id ?? null,
      appClientId: a.app_client_id ?? null,
      disabled: Boolean(a.disabled),
    })),
  });
});

// POST /import -- import accounts; skips existing by phone number
router.post("/import", (req, res) => {
  const { accounts: items } = req.body as { accounts?: AccountImportItem[] };
  if (!Array.isArray(items)) {
    res.status(400).json({ error: "accounts array required" });
    return;
  }
  let imported = 0;
  let skipped = 0;
  for (const a of items) {
    if (!a.phoneNumber || !a.apiId || !a.apiHash) {
      skipped++;
      continue;
    }
    const existing = db
      .prepare("SELECT id FROM tg_accounts WHERE phone_number = ?")
      .get(a.phoneNumber) as { id: number } | undefined;
    if (existing) {
      skipped++;
      continue;
    }
    db.prepare(
      "INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, session_string, auth_status, proxy_id, app_client_id, disabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      a.name || a.phoneNumber,
      a.phoneNumber,
      Number(a.apiId),
      a.apiHash,
      a.sessionString ?? null,
      a.authStatus ?? "unauthenticated",
      a.proxyId ?? null,
      a.appClientId ?? null,
      a.disabled ? 1 : 0,
    );
    imported++;
  }
  res.json({ imported, skipped });
});

router.put("/:id", (req, res) => {
  const { name, phoneNumber, apiId, apiHash, proxyId, disabled, appClientId } =
    req.body as Record<string, string | null | boolean>;
  const existing = db
    .prepare("SELECT * FROM tg_accounts WHERE id = ?")
    .get(req.params.id) as AccountRow | undefined;
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  // undefined = not in payload (keep existing), null/'' = clear
  const newProxyId =
    proxyId !== undefined ? proxyId || null : existing.proxy_id;
  const newDisabled =
    disabled !== undefined ? (disabled ? 1 : 0) : existing.disabled;
  const newAppClientId =
    appClientId !== undefined ? appClientId || null : existing.app_client_id;

  db.prepare(
    "UPDATE tg_accounts SET name = ?, phone_number = ?, api_id = ?, api_hash = ?, proxy_id = ?, disabled = ?, app_client_id = ? WHERE id = ?",
  ).run(
    name ?? existing.name,
    phoneNumber ?? existing.phone_number,
    Number(apiId ?? existing.api_id),
    apiHash ?? existing.api_hash,
    newProxyId,
    newDisabled,
    newAppClientId,
    req.params.id,
  );

  const row = db
    .prepare("SELECT * FROM tg_accounts WHERE id = ?")
    .get(req.params.id) as AccountRow;
  res.json(toJson(row));
});

router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM tg_accounts WHERE id = ?").run(req.params.id);
  res.status(204).send();
});

// ── TG account status check ─────────────────────────────────────────────────

router.post("/:id/check-status", async (req, res) => {
  const account = db
    .prepare("SELECT * FROM tg_accounts WHERE id = ?")
    .get(req.params.id) as AccountRow | undefined;
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }

  try {
    const proxyUrl = resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = resolveAppClientParams(account.app_client_id);
    const status = await checkAccountStatus(
      account.api_id,
      account.api_hash,
      account.session_string,
      proxy,
      deviceParams,
    );
    if (statusNeedsReauth(status)) markSessionExpired(account.id);
    saveTgMeta(account.id, status.firstName, status.lastName, status.username);
    res.json(status);
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) markSessionExpired(account.id);
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/refresh-tg-meta -- fetch TG display name and persist it; returns { tgDisplayName, tgUsername }
router.post("/:id/refresh-tg-meta", async (req, res) => {
  const account = db
    .prepare("SELECT * FROM tg_accounts WHERE id = ?")
    .get(req.params.id) as AccountRow | undefined;
  if (!account) { res.status(404).json({ error: "Not found" }); return; }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }
  try {
    const proxyUrl = resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = resolveAppClientParams(account.app_client_id);
    const status = await checkAccountStatus(
      account.api_id,
      account.api_hash,
      account.session_string,
      proxy,
      deviceParams,
    );
    if (statusNeedsReauth(status)) markSessionExpired(account.id);
    saveTgMeta(account.id, status.firstName, status.lastName, status.username);
    const displayName = [status.firstName, status.lastName].filter(Boolean).join(" ");
    res.json({ tgDisplayName: displayName || null, tgUsername: status.username ?? null });
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) markSessionExpired(account.id);
    res.status(500).json({ error: err.message });
  }
});

// POST /check-enabled-sessions -- check all enabled+authenticated accounts and mark expired ones
router.post("/check-enabled-sessions", async (req, res) => {
  const rows = db
    .prepare(
      "SELECT * FROM tg_accounts WHERE disabled = 0 AND auth_status = 'authenticated'",
    )
    .all() as AccountRow[];

  const results = await Promise.allSettled(
    rows.map(async (account) => {
      if (!account.session_string) return { id: account.id, expired: true };
      try {
        const proxyUrl = resolveProxyUrl(account.proxy_id);
        const proxy = parseTgProxy(proxyUrl);
        const deviceParams = resolveAppClientParams(account.app_client_id);
        const status = await checkAccountStatus(
          account.api_id,
          account.api_hash,
          account.session_string,
          proxy,
          deviceParams,
        );
        if (statusNeedsReauth(status)) {
          markSessionExpired(account.id);
          return { id: account.id, expired: true };
        }
        return { id: account.id, expired: false };
      } catch (err: any) {
        if (isAuthError(err?.message ?? "")) {
          markSessionExpired(account.id);
          return { id: account.id, expired: true };
        }
        return { id: account.id, expired: false };
      }
    }),
  );

  const expired = results
    .filter(
      (r) =>
        r.status === "fulfilled" &&
        (r as PromiseFulfilledResult<any>).value.expired,
    )
    .map((r) => (r as PromiseFulfilledResult<any>).value.id);

  res.json({ checked: rows.length, expired });
});

// POST /:id/check-spam -- send /start to @SpamBot and return the parsed spam status
router.post("/:id/check-spam", async (req, res) => {
  const account = db
    .prepare("SELECT * FROM tg_accounts WHERE id = ?")
    .get(req.params.id) as AccountRow | undefined;
  if (!account) { res.status(404).json({ error: "Not found" }); return; }
  if (!account.session_string) {
    res.status(400).json({ error: "Account not authenticated" });
    return;
  }

  try {
    const proxyUrl = resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = resolveAppClientParams(account.app_client_id);
    const result = await checkSpamStatus(
      account.api_id,
      account.api_hash,
      account.session_string,
      proxy,
      deviceParams,
    );
    res.json(result);
  } catch (err: any) {
    if (isAuthError(err?.message ?? "")) markSessionExpired(account.id);
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/force-reauth -- clear session and reset auth status so the account can be re-authenticated
router.post("/:id/force-reauth", (req, res) => {
  const account = db
    .prepare("SELECT * FROM tg_accounts WHERE id = ?")
    .get(req.params.id) as AccountRow | undefined;
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  db.prepare(
    "UPDATE tg_accounts SET session_string = NULL, auth_status = 'unauthenticated' WHERE id = ?",
  ).run(account.id);
  markSessionExpired(account.id);
  const row = db
    .prepare("SELECT * FROM tg_accounts WHERE id = ?")
    .get(account.id) as AccountRow;
  res.json(toJson(row));
});

// ── Telegram auth flow ──────────────────────────────────────────────────────

router.post("/:id/auth/request", async (req, res) => {
  const account = db
    .prepare("SELECT * FROM tg_accounts WHERE id = ?")
    .get(req.params.id) as AccountRow | undefined;
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  try {
    const proxyUrl = resolveProxyUrl(account.proxy_id);
    const proxy = parseTgProxy(proxyUrl);
    const deviceParams = resolveAppClientParams(account.app_client_id);
    const { isCodeViaApp } = await requestCode(
      account.id,
      account.api_id,
      account.api_hash,
      account.phone_number,
      proxy,
      deviceParams,
    );
    db.prepare(
      "UPDATE tg_accounts SET auth_status = 'pending_code' WHERE id = ?",
    ).run(account.id);
    res.json({ message: "Verification code sent", isCodeViaApp });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/auth/resend", async (req, res) => {
  const account = db
    .prepare("SELECT * FROM tg_accounts WHERE id = ?")
    .get(req.params.id) as AccountRow | undefined;
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    await resendCodeAsSms(account.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/auth/verify", async (req, res) => {
  const account = db
    .prepare("SELECT * FROM tg_accounts WHERE id = ?")
    .get(req.params.id) as AccountRow | undefined;
  if (!account) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const { code, password } = req.body as { code?: string; password?: string };

  try {
    if (account.auth_status === "pending_code" && code) {
      const result = await submitCode(account.id, code);
      if (result.needsPassword) {
        db.prepare(
          "UPDATE tg_accounts SET auth_status = 'pending_2fa' WHERE id = ?",
        ).run(account.id);
        res.json({ step: "2fa" });
      } else {
        db.prepare(
          "UPDATE tg_accounts SET auth_status = 'authenticated', session_string = ? WHERE id = ?",
        ).run(result.session, account.id);
        res.json({ step: "done" });
      }
    } else if (account.auth_status === "pending_2fa" && password) {
      const session = await submitPassword(account.id, password);
      db.prepare(
        "UPDATE tg_accounts SET auth_status = 'authenticated', session_string = ? WHERE id = ?",
      ).run(session, account.id);
      res.json({ step: "done" });
    } else {
      res
        .status(400)
        .json({ error: "Invalid auth state or missing credentials" });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
