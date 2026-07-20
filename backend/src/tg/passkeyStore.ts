import { db } from "../db/database";

// Private keys for passkeys we registered are kept in the existing settings
// key-value table (no new schema) as a JSON map keyed by the Telegram passkey id.
// These are the secret halves of WebAuthn credentials -- treat as sensitive.
const STORE_KEY = "tg_passkey_secrets";

export type PasskeySecret = {
  accountId: number;
  telegramPasskeyId: string;
  credentialId: string; // base64url, used for the assertion's id/raw_id
  privateKeyPem: string;
  rpId: string;
  userHandle: string; // base64url user.id from the registration options
  createdDate: number;
  // Account's home DC, captured while a session exists so passkey login still
  // works after force-reauth clears the session string.
  dcId?: number;
  serverAddress?: string;
  port?: number;
};

type Store = Record<string, PasskeySecret>;

function readStore(): Store {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(STORE_KEY) as
    | { value: string }
    | undefined;
  if (!row?.value) return {};
  try {
    return JSON.parse(row.value) as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    STORE_KEY,
    JSON.stringify(store),
  );
}

export function savePasskeySecret(secret: PasskeySecret): void {
  const store = readStore();
  store[secret.telegramPasskeyId] = secret;
  writeStore(store);
}

export function getPasskeySecret(telegramPasskeyId: string): PasskeySecret | undefined {
  return readStore()[telegramPasskeyId];
}

export function deletePasskeySecret(telegramPasskeyId: string): void {
  const store = readStore();
  if (store[telegramPasskeyId]) {
    delete store[telegramPasskeyId];
    writeStore(store);
  }
}

// Drop stored secrets for an account whose passkey no longer exists on Telegram.
export function pruneAccountPasskeySecrets(
  accountId: number,
  liveIds: string[],
): void {
  const live = new Set(liveIds);
  const store = readStore();
  let changed = false;
  for (const [id, s] of Object.entries(store)) {
    if (s.accountId === accountId && !live.has(id)) {
      delete store[id];
      changed = true;
    }
  }
  if (changed) writeStore(store);
}

// Telegram passkey ids that we hold the private key for (for a given account).
export function storedPasskeyIdsForAccount(accountId: number): string[] {
  return accountPasskeySecrets(accountId).map((s) => s.telegramPasskeyId);
}

export function accountPasskeySecrets(accountId: number): PasskeySecret[] {
  return Object.values(readStore()).filter((s) => s.accountId === accountId);
}

// True when the account has a stored passkey usable for login (key + known DC),
// i.e. auth/request would attempt passkey login rather than the code flow.
export function accountHasUsablePasskey(accountId: number): boolean {
  return Object.values(readStore()).some(
    (s) => s.accountId === accountId && s.dcId != null,
  );
}

// Backfill/refresh the account's home DC on every stored secret for that account.
export function setAccountPasskeyDc(
  accountId: number,
  dc: { dcId: number; serverAddress: string; port: number },
): void {
  const store = readStore();
  let changed = false;
  for (const s of Object.values(store)) {
    if (s.accountId === accountId) {
      s.dcId = dc.dcId;
      s.serverAddress = dc.serverAddress;
      s.port = dc.port;
      changed = true;
    }
  }
  if (changed) writeStore(store);
}
