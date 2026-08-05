import { db } from "../db/database";

/**
 * What a job's `web_collect` steps have already handed to a loop, so a run does not work
 * the same value twice. Kept in the settings table under one row per job and collect name,
 * rather than in a table of its own: it is a short list of ids, only this job reads it, and
 * it is throwaway state -- losing it costs a duplicate reply, not data.
 *
 * Per job by design. Several accounts usually run their own copy of the same job, and each
 * one should still get the whole list to choose from.
 */

/** Oldest entries are dropped past this, so a long-running job's row cannot grow forever. */
const MAX_REMEMBERED = 1000;

function keyFor(jobId: number, varName: string): string {
  return `web_used:${jobId}:${varName}`;
}

export function usedWebValues(jobId: number | undefined, varName: string): string[] {
  if (!jobId) return [];
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(keyFor(jobId, varName)) as { value: string } | undefined;
    if (!row?.value) return [];
    const list = JSON.parse(row.value);
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function rememberWebValue(
  jobId: number | undefined,
  varName: string,
  value: string,
): void {
  if (!jobId || !value) return;
  try {
    const kept = usedWebValues(jobId, varName).filter((v) => v !== value);
    kept.push(value);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(keyFor(jobId, varName), JSON.stringify(kept.slice(-MAX_REMEMBERED)));
  } catch (e) {
    console.error("[web] could not remember a used value:", e);
  }
}

/** Wipes a job's memory, for the button that lets a job work the whole list again. */
export function forgetWebValues(jobId: number): void {
  try {
    db.prepare("DELETE FROM settings WHERE key LIKE ?").run(`web_used:${jobId}:%`);
  } catch (e) {
    console.error("[web] could not clear used values:", e);
  }
}
