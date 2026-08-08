import { db } from "./database";
import { decryptSecret, encryptSecret } from "./secretColumns";

// Named values a config refers to as `{name}` -- a Gmail app password, for one -- kept apart
// from settings because a setting is served to the panel and one of these never is. Only the
// key and when it was last written ever leave the backend; the value is read where the step
// that needs it runs.
//
// Stored through the same BEMBY_DATA_KEY encryption the account columns use, so a copy of the
// database file is not a copy of the credentials on an install that has opted in.

/** Names are used as `{name}`, so they have to look like a placeholder token. */
export const SECRET_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export type SecretSummary = { key: string; updatedAt: string | null };

export function isValidSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/** Every stored name, without the values. */
export function listSecrets(): SecretSummary[] {
  const rows = db
    .prepare("SELECT key, updated_at FROM secrets ORDER BY key")
    .all() as Array<{ key: string; updated_at: string | null }>;
  return rows.map((r) => ({ key: r.key, updatedAt: r.updated_at }));
}

export function getSecret(key: string): string | null {
  const row = db.prepare("SELECT value FROM secrets WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return null;
  return decryptSecret(row.value) ?? null;
}

export function setSecret(key: string, value: string): void {
  db.prepare(
    `INSERT INTO secrets (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  ).run(key, encryptSecret(value));
}

export function deleteSecret(key: string): boolean {
  return db.prepare("DELETE FROM secrets WHERE key = ?").run(key).changes > 0;
}

/**
 * Swaps `{name}` for the stored value, for a field that is meant to hold a credential.
 * Deliberately not applied to every field a config has: a page step's text is expanded with
 * the round's own names and the random tokens, and quietly resolving secrets there would put
 * one on screen, in a screenshot, and in the job log.
 *
 * A name with nothing stored under it is left as it stands, so the step that wanted it fails
 * with the reference still visible rather than sending an empty password.
 */
export function fillSecrets(text: string): string {
  if (!text) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => getSecret(name) ?? whole);
}

/** Names a field refers to that have nothing stored under them, for a clear error. */
export function missingSecretRefs(text: string): string[] {
  const missing: string[] = [];
  for (const [, name] of (text ?? "").matchAll(/\{(\w+)\}/g)) {
    if (getSecret(name) === null) missing.push(name);
  }
  return missing;
}
