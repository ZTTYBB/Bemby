import { TelegramClient, Logger } from "telegram";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import type { TgAccount } from "../types";
import { db } from "../db/database";

export type NotifyConfig = {
  username: string | null;
  events: string[];
};

/** Normalises username / @username / https://t.me/username to a bare @username peer string. */
export function normaliseNotifyTarget(raw: string): string {
  const s = raw.trim();
  // t.me URL
  const tme = s.match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{3,})/);
  if (tme) return `@${tme[1]}`;
  // Strip leading @, re-add to normalise
  const stripped = s.replace(/^@/, "");
  return `@${stripped}`;
}

export function getNotifyConfig(): NotifyConfig {
  const rows = db
    .prepare(
      "SELECT key, value FROM settings WHERE key IN ('notify_tg_username', 'notify_tg_events')",
    )
    .all() as { key: string; value: string }[];
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  let events: string[] = ["failed"];
  try {
    if (map.notify_tg_events) events = JSON.parse(map.notify_tg_events);
  } catch {
    /* ignore */
  }
  const raw = map.notify_tg_username?.trim();
  return {
    username: raw ? normaliseNotifyTarget(raw) : null,
    events,
  };
}

/**
 * Sends a notification via the given account's session.
 * target defaults to 'me' (Saved Messages).
 * Fire-and-forget -- callers should .catch() any rejection.
 */
export async function sendTgNotify(
  account: TgAccount,
  message: string,
  target = "me",
): Promise<void> {
  if (!account.sessionString) return;

  const client = new TelegramClient(
    new StringSession(account.sessionString),
    account.apiId,
    account.apiHash,
    {
      connectionRetries: 3,
      autoReconnect: false,
      baseLogger: new Logger(LogLevel.NONE),
    },
  );

  try {
    await client.connect();
    await client.sendMessage(target, { message });
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
  }
}

export function buildFailureMessage(
  jobName: string,
  jobType: string,
  errorMessage: string,
): string {
  return [
    "❌ Bemby job failed",
    "",
    `Job: ${jobName}`,
    `Type: ${jobType}`,
    `Error: ${errorMessage}`,
  ].join("\n");
}

export function buildSuccessMessage(jobName: string, jobType: string): string {
  return [
    "✅ Bemby job succeeded",
    "",
    `Job: ${jobName}`,
    `Type: ${jobType}`,
  ].join("\n");
}
