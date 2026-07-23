import {
  db,
  getDefaultTgApiCredentials,
  getDefaultTimezone,
  FALLBACK_TIMEZONE,
} from "./db/database";
import { runJob, type JobDetailLog } from "./jobs/runner";
import {
  sendTgNotify,
  buildFailureMessage,
  buildSuccessMessage,
  getNotifyConfig,
} from "./jobs/notify";
import type { Job, TgAccount } from "./types";
import { DateTime, IANAZone } from "luxon";
import {
  registerJob,
  unregisterJob,
  registerLiveDetail,
  clearLiveDetail,
} from "./jobs/cancellation";
import { toMinutes, pickNextRun } from "./scheduler-utils";

type ScheduleEntry = {
  job: Job;
  account: TgAccount | null;
  /** Timezone the nextRun was computed in, after resolving the default. */
  timezone: string;
  nextRun: Date;
  timer: ReturnType<typeof setTimeout>;
};

const schedule = new Map<number, ScheduleEntry>();

/** Node's setTimeout delay is a 32-bit signed int; larger values overflow and
 * fire almost immediately (coerced to 1ms). See issue #25. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * setTimeout for delays that may exceed Node's 32-bit limit (~24.8 days).
 * Chains timers, re-arming until the remaining delay fits. `onTimer` is called
 * with each armed timer handle so the caller can keep a clearable reference to
 * the currently-pending timer.
 */
function armLongTimeout(
  delayMs: number,
  callback: () => void,
  onTimer: (timer: ReturnType<typeof setTimeout>) => void,
): void {
  if (delayMs <= MAX_TIMEOUT_MS) {
    onTimer(setTimeout(callback, delayMs));
    return;
  }
  onTimer(
    setTimeout(
      () => armLongTimeout(delayMs - MAX_TIMEOUT_MS, callback, onTimer),
      MAX_TIMEOUT_MS,
    ),
  );
}

export const DEFAULT_SCHEDULE_GAP_MINUTES = 2;
const MAX_SCHEDULE_GAP_MINUTES = 30;

/** Minimum minutes between scheduled runs. 0 disables staggering. */
export function getScheduleGapMinutes(): number {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'schedule_min_gap_minutes'")
    .get() as { value: string } | undefined;
  if (row?.value == null || row.value === "")
    return DEFAULT_SCHEDULE_GAP_MINUTES;
  const n = Number(row.value);
  if (!Number.isFinite(n)) return DEFAULT_SCHEDULE_GAP_MINUTES;
  return Math.min(MAX_SCHEDULE_GAP_MINUTES, Math.max(0, Math.floor(n)));
}

// Cap on simultaneous job executions -- colliding timers queue instead of
// thundering the Telegram client all at once.
const MAX_CONCURRENT_JOBS = 2;
let runningJobs = 0;
const waitingJobs: Array<() => void> = [];

async function acquireRunSlot(): Promise<void> {
  if (runningJobs < MAX_CONCURRENT_JOBS) {
    runningJobs++;
    return;
  }
  // Slot is handed over directly by releaseRunSlot, so no counter change here
  await new Promise<void>((resolve) => waitingJobs.push(resolve));
}

function releaseRunSlot(): void {
  const next = waitingJobs.shift();
  if (next) next();
  else runningJobs--;
}

/**
 * Resolves a job's timezone for scheduling. Empty means "follow the
 * default_timezone setting"; invalid zones fall back rather than producing
 * NaN timers.
 */
export function resolveJobTimezone(jobTimezone: string | null | undefined): string {
  const tz = jobTimezone || getDefaultTimezone();
  if (IANAZone.isValidZone(tz)) return tz;
  const fallback = getDefaultTimezone();
  return IANAZone.isValidZone(fallback) ? fallback : FALLBACK_TIMEZONE;
}

function checkDailyRunEnabled(): boolean {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'check_daily_run'")
    .get() as { value: string } | undefined;
  return row?.value !== "false";
}

export function daysUntilNextRun(
  jobId: number,
  tz: string,
  runEveryDays: number,
): number {
  const row = db
    .prepare(
      "SELECT ran_at FROM job_logs WHERE job_id = ? AND status = 'success' ORDER BY ran_at DESC LIMIT 1",
    )
    .get(jobId) as { ran_at: string } | undefined;
  if (!row) return 0;
  const lastRun = DateTime.fromISO(row.ran_at, { zone: "utc" })
    .setZone(tz)
    .startOf("day");
  const today = DateTime.now().setZone(tz).startOf("day");
  const daysSince = Math.floor(today.diff(lastRun, "days").days);
  return daysSince >= runEveryDays ? 0 : runEveryDays - daysSince;
}

export function loadEligibleJobs(): Array<{
  job: Job;
  account: TgAccount | null;
}> {
  const rows = db
    .prepare(
      `
    SELECT j.*,
           a.api_id, a.api_hash, a.session_string, a.auth_status, a.proxy_id AS account_proxy_id,
           a.name AS account_name, a.phone_number, a.created_at AS account_created_at, a.disabled AS account_disabled,
           a.app_client_id AS account_app_client_id
    FROM jobs j
    LEFT JOIN tg_accounts a ON j.account_id = a.id
    WHERE j.enabled = 1
      AND j.retired IS NULL
      AND (j.account_id IS NULL OR (a.id IS NOT NULL AND a.disabled = 0))
      AND (
        (j.job_type NOT IN ('checkin', 'custom', 'autoreg'))
        OR (a.auth_status = 'authenticated' AND a.session_string IS NOT NULL)
      )
  `,
    )
    .all() as any[];

  return rows.map((row) => ({
    job: {
      id: row.id,
      name: row.name,
      accountId: row.account_id ?? null,
      jobType: row.job_type,
      botUsername: row.bot_username,
      scheduleWindowStart: row.schedule_window_start,
      scheduleWindowEnd: row.schedule_window_end,
      timezone: row.timezone,
      replyTimeoutMs: row.reply_timeout_ms,
      retryMax: row.retry_max,
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
      config: row.config ?? null,
      startCommand: row.start_command || "/start",
      checkinButton: row.checkin_button || "签到",
      runEveryDays: row.run_every_days ?? 1,
    } as Job,
    account:
      row.account_id != null
        ? (() => {
            // Credentials resolve as a pair: the account's own if complete, else global defaults
            const ownCredentials =
              row.api_id && row.api_hash
                ? { apiId: row.api_id, apiHash: row.api_hash }
                : null;
            const credentials =
              ownCredentials ?? getDefaultTgApiCredentials();
            return {
              id: row.account_id,
              name: row.account_name,
              phoneNumber: row.phone_number,
              apiId: credentials?.apiId ?? null,
              apiHash: credentials?.apiHash ?? null,
              sessionString: row.session_string,
              authStatus: row.auth_status,
              proxyId: row.account_proxy_id ?? null,
              disabled: Boolean(row.account_disabled),
              appClientId: row.account_app_client_id ?? null,
              createdAt: row.account_created_at,
            } as TgAccount;
          })()
        : null,
  }));
}

export async function executeJob(
  job: Job,
  account: TgAccount | null,
): Promise<void> {
  await acquireRunSlot();
  const detailLogs: JobDetailLog[] = [];
  let logId: number | bigint | undefined;
  try {
    // Re-fetch job settings so changes made after scheduling take effect
    const freshJob = db
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get(job.id) as any;
    if (freshJob) {
      job = {
        id: freshJob.id,
        name: freshJob.name,
        accountId: freshJob.account_id ?? null,
        jobType: freshJob.job_type,
        botUsername: freshJob.bot_username,
        scheduleWindowStart: freshJob.schedule_window_start,
        scheduleWindowEnd: freshJob.schedule_window_end,
        timezone: freshJob.timezone,
        replyTimeoutMs: freshJob.reply_timeout_ms,
        retryMax: freshJob.retry_max,
        enabled: Boolean(freshJob.enabled),
        createdAt: freshJob.created_at,
        config: freshJob.config ?? null,
        startCommand: freshJob.start_command || "/start",
        checkinButton: freshJob.checkin_button || "签到",
        templateId: freshJob.template_id ?? null,
        runEveryDays: freshJob.run_every_days ?? 1,
      };
    }

    const ranAt = new Date().toISOString();
    logId = db
      .prepare(
        "INSERT INTO job_logs (job_id, ran_at, status, message) VALUES (?, ?, 'running', 'Scheduled')",
      )
      .run(job.id, ranAt).lastInsertRowid;

    const signal = registerJob(Number(logId));
    registerLiveDetail(Number(logId), detailLogs);

    // Re-fetch session in case it was updated since scheduling
    if (account) {
      const fresh = db
        .prepare("SELECT session_string FROM tg_accounts WHERE id = ?")
        .get(account.id) as any;
      if (fresh?.session_string)
        account = { ...account, sessionString: fresh.session_string };
    }

    await runJob(job, account, detailLogs, signal);
    const detail = detailLogs.length ? JSON.stringify(detailLogs) : null;
    db.prepare(
      "UPDATE job_logs SET status = 'success', message = 'Completed', detail = ? WHERE id = ?",
    ).run(detail, logId);
    console.log(`[scheduler] "${job.name}" completed`);
    if (account?.sessionString) {
      const cfg = getNotifyConfig();
      if (cfg.events.includes("success") && (cfg.username || false)) {
        sendTgNotify(
          account,
          buildSuccessMessage(job.name, job.jobType),
          cfg.username!,
        ).catch((e) => console.warn("[notify] TG notification failed:", e));
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isCancelled = message === "Job cancelled";
    if (logId !== undefined) {
      const detail = detailLogs.length ? JSON.stringify(detailLogs) : null;
      db.prepare(
        "UPDATE job_logs SET status = 'failed', message = ?, detail = ? WHERE id = ?",
      ).run(isCancelled ? "Cancelled" : message, detail, logId);
    }
    console.error(`[scheduler] "${job.name}" failed:`, message);
    if (!isCancelled && account?.sessionString) {
      const cfg = getNotifyConfig();
      if (cfg.events.includes("failed")) {
        const target = cfg.username ?? "me";
        sendTgNotify(
          account,
          buildFailureMessage(job.name, job.jobType, message),
          target,
        ).catch((e) => console.warn("[notify] TG notification failed:", e));
      }
    }
  } finally {
    releaseRunSlot();
    if (logId !== undefined) {
      unregisterJob(Number(logId));
      clearLiveDetail(Number(logId));
    }
    // Only re-arm the timer if the job still exists and is enabled — a job
    // disabled or deleted mid-run must not reschedule itself (refreshJobs is
    // the authority and would otherwise not catch it before the next fire).
    const current = db
      .prepare("SELECT enabled FROM jobs WHERE id = ?")
      .get(job.id) as { enabled: number } | undefined;
    if (current?.enabled) {
      scheduleOne(job, account, job.runEveryDays ?? 1);
    }
  }
}

function scheduleOne(job: Job, account: TgAccount | null, daysAhead = 0): void {
  const existing = schedule.get(job.id);
  if (existing) clearTimeout(existing.timer);

  // Stagger away from every other job's slot so runs don't pile into the
  // same minute (issue #10)
  const occupied = Array.from(schedule.values())
    .filter((entry) => entry.job.id !== job.id)
    .map((entry) => entry.nextRun.getTime());

  const timezone = resolveJobTimezone(job.timezone);
  const nextRun = pickNextRun(
    job.scheduleWindowStart,
    job.scheduleWindowEnd,
    timezone,
    daysAhead,
    { occupied, gapMinutes: getScheduleGapMinutes() },
  );
  const delayMs = Math.max(0, nextRun.toMillis() - Date.now());

  let timer!: ReturnType<typeof setTimeout>;
  armLongTimeout(
    delayMs,
    () => executeJob(job, account),
    (t) => {
      timer = t;
      const entry = schedule.get(job.id);
      if (entry) entry.timer = t;
    },
  );
  schedule.set(job.id, {
    job,
    account,
    timezone,
    nextRun: nextRun.toJSDate(),
    timer,
  });

  console.log(
    `[scheduler] "${job.name}" next run: ${nextRun.toISO()} (in ${Math.round(delayMs / 60_000)} min)`,
  );
}

function refreshJobs(): void {
  const eligible = loadEligibleJobs();
  const eligibleIds = new Set(eligible.map((e) => e.job.id));

  // Remove jobs no longer eligible
  for (const [id, entry] of schedule) {
    if (!eligibleIds.has(id)) {
      clearTimeout(entry.timer);
      schedule.delete(id);
      console.log(`[scheduler] Unscheduled job ${id}`);
    }
  }

  const dailyCheckOn = checkDailyRunEnabled();

  // Add newly eligible jobs, or re-schedule if config changed
  for (const { job, account } of eligible) {
    const existing = schedule.get(job.id);
    const resolvedTz = resolveJobTimezone(job.timezone);
    if (!existing) {
      const daysAhead = dailyCheckOn
        ? daysUntilNextRun(job.id, resolvedTz, job.runEveryDays ?? 1)
        : 0;
      scheduleOne(job, account, daysAhead);
    } else {
      // Compare resolved timezones so a default_timezone change reschedules
      // jobs that follow the default
      const scheduleChanged =
        existing.job.scheduleWindowStart !== job.scheduleWindowStart ||
        existing.job.scheduleWindowEnd !== job.scheduleWindowEnd ||
        existing.timezone !== resolvedTz ||
        existing.job.botUsername !== job.botUsername ||
        existing.job.accountId !== job.accountId ||
        existing.job.runEveryDays !== job.runEveryDays;
      if (scheduleChanged) {
        const daysAhead = dailyCheckOn
          ? daysUntilNextRun(job.id, resolvedTz, job.runEveryDays ?? 1)
          : 0;
        scheduleOne(job, account, daysAhead);
      } else {
        // Keep the timer but update the stored snapshot so status reflects current settings
        schedule.set(job.id, { ...existing, job, account });
      }
    }
  }
}

export function refreshScheduler(): void {
  refreshJobs();
}

/** Deletes job logs older than the configured retention window. 0 keeps everything. */
export function purgeOldLogs(): void {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'log_retention_days'")
    .get() as { value: string } | undefined;
  const days = Number(row?.value ?? 0);
  if (!Number.isFinite(days) || days <= 0) return;

  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const { changes } = db
    .prepare("DELETE FROM job_logs WHERE ran_at < ? AND status != 'running'")
    .run(cutoff);
  if (changes > 0) {
    console.log(
      `[scheduler] Purged ${changes} job log(s) older than ${days} day(s)`,
    );
  }
}

/**
 * Mark any job_logs still in 'running' state as failed. On a fresh process
 * start nothing is actually running, so a leftover 'running' row means the
 * previous process was killed mid-run (e.g. during an upgrade), leaving the
 * log stuck and un-stoppable. (issue #18)
 */
export function reconcileOrphanedRuns(): void {
  const { changes } = db
    .prepare(
      "UPDATE job_logs SET status = 'failed', message = 'Interrupted by server restart' WHERE status = 'running'",
    )
    .run();
  if (changes > 0) {
    console.log(`[scheduler] Marked ${changes} interrupted run(s) as failed`);
  }
}

export function startScheduler(): void {
  console.log("[scheduler] Starting");
  reconcileOrphanedRuns();
  refreshJobs();
  // Re-check every 5 minutes to pick up new/changed jobs
  setInterval(refreshJobs, 5 * 60 * 1000);
  purgeOldLogs();
  // Retention sweep is cheap, so hourly keeps the table tidy without load
  setInterval(purgeOldLogs, 60 * 60 * 1000);
}

export function getSchedulerStatus(): Array<{
  jobId: number;
  jobName: string;
  nextRun: string;
}> {
  return Array.from(schedule.values()).map(({ job, nextRun }) => ({
    jobId: job.id,
    jobName: job.name,
    nextRun: nextRun.toISOString(),
  }));
}
