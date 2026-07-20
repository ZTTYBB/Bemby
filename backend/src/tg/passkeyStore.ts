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

// Telegram passkey ids that we hold the private key for (for a given account).
export function storedPasskeyIdsForAccount(accountId: number): string[] {
  return Object.values(readStore())
    .filter((s) => s.accountId === accountId)
    .map((s) => s.telegramPasskeyId);
}
