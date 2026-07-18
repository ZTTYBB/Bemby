import crypto from "crypto";
import { db, getDefaultTgApiCredentials } from "../db/database";
import { requestCode, submitCode, submitPassword } from "../auth/tgAuth";
import { parseTgProxy } from "./runner";
import { resolveAppClientParams } from "../tg/appClient";

// Bulk-adds Telegram accounts whose verification code + 2FA are served by an
// external "getcode" API page (one page per account). Accounts are created
// first, then authenticated one at a time: request code, poll the API page for
// the code, submit it, submit the 2FA password, then pause before the next.

export type BulkAddItemStatus =
  | "pending"
  | "requesting_code"
  | "fetching_code"
  | "submitting_code"
  | "submitting_2fa"
  | "waiting"
  | "done"
  | "failed";

export type BulkAddItem = {
  index: number;
  phoneNumber: string;
  apiUrl: string;
  accountId: number | null;
  accountName: string | null;
  status: BulkAddItemStatus;
  message: string;
  error: string | null;
};

export type BulkAddBatch = {
  id: string;
  createdAt: string;
  running: boolean;
  cancelled: boolean;
  total: number;
  items: BulkAddItem[];
};

export type ParsedBulkLine = { phoneNumber: string; apiUrl: string };

// Line separator between phone number and API URL, e.g.
// +917507166497----https://example.com/getcode?id=...
const SEPARATOR = "----";

export function parseBulkAddInput(text: string): {
  lines: ParsedBulkLine[];
  errors: string[];
} {
  const lines: ParsedBulkLine[] = [];
  const errors: string[] = [];
  const raw = (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of raw) {
    const idx = line.indexOf(SEPARATOR);
    if (idx === -1) {
      errors.push(`Missing "${SEPARATOR}" separator: ${line}`);
      continue;
    }
    const phoneNumber = line.slice(0, idx).trim();
    const apiUrl = line.slice(idx + SEPARATOR.length).trim();
    if (!phoneNumber || !apiUrl) {
      errors.push(`Incomplete line: ${line}`);
      continue;
    }
    lines.push({ phoneNumber, apiUrl });
  }
  return { lines, errors };
}

// Pulls the verification code and 2FA password out of the getcode page HTML.
// The page renders them as readonly inputs: <input id="code" value="42344">
// and <input id="pass2fa" value="bemby">.
export function extractApiCredentials(html: string): {
  code: string;
  pass2fa: string;
} {
  const readValue = (id: string): string => {
    const tag = html.match(
      new RegExp(`<input[^>]*\\bid=["']${id}["'][^>]*>`, "i"),
    )?.[0];
    return tag?.match(/\bvalue=["']([^"']*)["']/i)?.[1]?.trim() ?? "";
  };
  return { code: readValue("code"), pass2fa: readValue("pass2fa") };
}

type BulkAddTimings = {
  /** Wait after requesting a code before first polling the API page. */
  initialWaitMs: number;
  /** Wait after a failed/empty page fetch before retrying (rate limit). */
  rateLimitWaitMs: number;
  /** Pause after each account before moving to the next. */
  betweenAccountsMs: number;
  /** Max attempts to read a code from the API page. */
  maxFetchAttempts: number;
};

const DEFAULT_TIMINGS: BulkAddTimings = {
  initialWaitMs: 15_000,
  rateLimitWaitMs: 120_000,
  betweenAccountsMs: 60_000,
  maxFetchAttempts: 5,
};

let current: BulkAddBatch | null = null;

export function getBulkAddStatus(): BulkAddBatch | null {
  return current;
}

export function cancelBulkAdd(): boolean {
  if (!current || !current.running) return false;
  current.cancelled = true;
  return true;
}

function readSettingList<T>(key: string): T[] {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  try {
    return row?.value ? (JSON.parse(row.value) as T[]) : [];
  } catch {
    return [];
  }
}

function pickRandom<T>(arr: T[]): T | null {
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
}

function resolveProxyUrl(proxyId: string | null): string | undefined {
  if (!proxyId) return undefined;
  const list = readSettingList<{ id: string; url: string }>("proxies");
  return list.find((p) => p.id === proxyId)?.url;
}

// Abortable sleep -- resolves early when the batch is cancelled.
function sleep(ms: number, batch: BulkAddBatch): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (batch.cancelled || Date.now() - start >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(1000, ms));
    };
    tick();
  });
}

async function fetchApiCredentials(
  url: string,
): Promise<{ code: string; pass2fa: string }> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();
  return extractApiCredentials(html);
}

type AccountRow = {
  id: number;
  phone_number: string;
  api_id: number | null;
  api_hash: string | null;
  proxy_id: string | null;
  app_client_id: string | null;
};

async function authenticateAccount(
  batch: BulkAddBatch,
  item: BulkAddItem,
  timings: BulkAddTimings,
): Promise<void> {
  const account = db
    .prepare("SELECT * FROM tg_accounts WHERE id = ?")
    .get(item.accountId) as AccountRow | undefined;
  if (!account) throw new Error("Account not found");

  const own =
    account.api_id && account.api_hash
      ? { apiId: account.api_id, apiHash: account.api_hash }
      : null;
  const creds = own ?? getDefaultTgApiCredentials();
  if (!creds)
    throw new Error(
      "No API credentials -- configure global defaults in Settings",
    );

  const proxy = parseTgProxy(resolveProxyUrl(account.proxy_id));
  const deviceParams = resolveAppClientParams(
    account.id,
    account.app_client_id,
  );

  // 1. Request the verification code
  item.status = "requesting_code";
  item.message = "Requesting verification code";
  await requestCode(
    account.id,
    creds.apiId,
    creds.apiHash,
    account.phone_number,
    proxy,
    deviceParams,
  );
  db.prepare(
    "UPDATE tg_accounts SET auth_status = 'pending_code' WHERE id = ?",
  ).run(account.id);

  // 2. Poll the API page for the code (page is only populated after the code
  // is sent, and it rate-limits -- back off on failure/empty result)
  item.status = "fetching_code";
  item.message = "Waiting for code to arrive on API page";
  await sleep(timings.initialWaitMs, batch);
  if (batch.cancelled) throw new Error("Cancelled");

  let apiCreds: { code: string; pass2fa: string } | null = null;
  for (let attempt = 1; attempt <= timings.maxFetchAttempts; attempt++) {
    if (batch.cancelled) throw new Error("Cancelled");
    try {
      const r = await fetchApiCredentials(item.apiUrl);
      if (r.code) {
        apiCreds = r;
        break;
      }
      item.message = `Code not ready (attempt ${attempt}/${timings.maxFetchAttempts})`;
    } catch (err: any) {
      item.message = `Fetch failed (attempt ${attempt}/${timings.maxFetchAttempts}): ${err?.message ?? err}`;
    }
    if (attempt < timings.maxFetchAttempts) {
      item.message += ` -- retrying in ${Math.round(timings.rateLimitWaitMs / 1000)}s`;
      await sleep(timings.rateLimitWaitMs, batch);
    }
  }
  if (!apiCreds)
    throw new Error("Could not retrieve verification code from API page");

  // 3. Submit the code, then 2FA password if required
  item.status = "submitting_code";
  item.message = "Submitting verification code";
  const result = await submitCode(account.id, apiCreds.code);
  if (result.needsPassword) {
    db.prepare(
      "UPDATE tg_accounts SET auth_status = 'pending_2fa' WHERE id = ?",
    ).run(account.id);
    if (!apiCreds.pass2fa)
      throw new Error("2FA required but the API page has no password");
    item.status = "submitting_2fa";
    item.message = "Submitting 2FA password";
    const session = await submitPassword(account.id, apiCreds.pass2fa);
    db.prepare(
      "UPDATE tg_accounts SET auth_status = 'authenticated', session_string = ? WHERE id = ?",
    ).run(session, account.id);
  } else {
    db.prepare(
      "UPDATE tg_accounts SET auth_status = 'authenticated', session_string = ? WHERE id = ?",
    ).run(result.session, account.id);
  }

  item.status = "done";
  item.message = "Authenticated";
}

async function runBatch(
  batch: BulkAddBatch,
  timings: BulkAddTimings,
): Promise<void> {
  try {
    for (let i = 0; i < batch.items.length; i++) {
      if (batch.cancelled) break;
      const item = batch.items[i];
      try {
        await authenticateAccount(batch, item, timings);
      } catch (err: any) {
        item.status = "failed";
        item.error = err?.message ?? String(err);
        item.message = "Failed";
      }
      // Pause before the next account (skip after the last / on cancel)
      if (i < batch.items.length - 1 && !batch.cancelled) {
        const next = batch.items[i + 1];
        next.status = "waiting";
        next.message = `Waiting ${Math.round(timings.betweenAccountsMs / 1000)}s before next account`;
        await sleep(timings.betweenAccountsMs, batch);
      }
    }
  } finally {
    batch.running = false;
  }
}

// Creates the accounts for the parsed lines, returning the created items.
// Name = A_(current account count + 1), incrementing per account.
function createAccounts(lines: ParsedBulkLine[]): BulkAddItem[] {
  const proxies = readSettingList<{ id: string }>("proxies");
  const clients = readSettingList<{ id: string }>("tg_app_clients");

  const countRow = db
    .prepare("SELECT COUNT(*) AS c FROM tg_accounts")
    .get() as { c: number };
  const maxRow = db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM tg_accounts")
    .get() as { m: number };

  const items: BulkAddItem[] = [];
  let count = countRow.c;
  let sortOrder = maxRow.m;

  const insert = db.prepare(
    "INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, proxy_id, app_client_id, sort_order, notes) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)",
  );

  lines.forEach((line, index) => {
    const name = `A_${count + 1}`;
    const proxyId = pickRandom(proxies)?.id ?? null;
    const appClientId = pickRandom(clients)?.id ?? null;
    const notes = `Automatically added via ${line.apiUrl}`;
    const res = insert.run(
      name,
      line.phoneNumber,
      proxyId,
      appClientId,
      ++sortOrder,
      notes,
    );
    count++;
    items.push({
      index,
      phoneNumber: line.phoneNumber,
      apiUrl: line.apiUrl,
      accountId: Number(res.lastInsertRowid),
      accountName: name,
      status: "pending",
      message: "",
      error: null,
    });
  });

  return items;
}

export type StartBulkAddResult =
  | { ok: true; batch: BulkAddBatch }
  | { ok: false; error: string };

export function startBulkAdd(
  text: string,
  overrides?: Partial<BulkAddTimings>,
): StartBulkAddResult {
  if (current?.running) {
    return { ok: false, error: "A bulk-add batch is already running" };
  }

  const { lines, errors } = parseBulkAddInput(text);
  if (errors.length) {
    return { ok: false, error: errors.join("\n") };
  }
  if (!lines.length) {
    return { ok: false, error: "No valid account lines provided" };
  }
  if (!getDefaultTgApiCredentials()) {
    return {
      ok: false,
      error:
        "Global Telegram API credentials are required (configure them in Settings)",
    };
  }

  const timings = { ...DEFAULT_TIMINGS, ...overrides };
  const items = createAccounts(lines);

  const batch: BulkAddBatch = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    running: true,
    cancelled: false,
    total: items.length,
    items,
  };
  current = batch;
  void runBatch(batch, timings);
  return { ok: true, batch };
}
