import { DateTime } from "luxon";
import { db } from "./db/database";
import { runJob, type JobDetailLog } from "./jobs/runner";
import {
  sendTgNotify,
  buildFailureMessage,
  buildSuccessMessage,
  getNotifyConfig,
} from "./jobs/notify";
import type { Job, TgAccount } from "./types";
import { registerJob, unregisterJob, registerLiveDetail, clearLiveDetail } from "./jobs/cancellation";

type ScheduleEntry = {
  job: Job;
  account: TgAccount | null;
  nextRun: Date;
  timer: ReturnType<typeof setTimeout>;
};

const schedule = new Map<number, ScheduleEntry>();

function toMinutes(hhmm: number): number {
  return Math.floor(hhmm / 100) * 60 + (hhmm % 100);
}

function pickNextRun(
  windowStart: number,
  windowEnd: number,
  tz: string,
  forceTomorrow = false,
): DateTime {
  const startMin = toMinutes(windowStart);
  const endMin = toMinutes(windowEnd);
  const now = DateTime.now().setZone(tz);
  const nowMin = now.hour * 60 + now.minute;

  if (!forceTomorrow) {
    if (nowMin < startMin) {
      // Window hasn't started yet today — pick anywhere in the full window
      const randomMin =
        startMin + Math.floor(Math.random() * Math.max(1, endMin - startMin));
      return now.set({
        hour: Math.floor(randomMin / 60),
        minute: randomMin % 60,
        second: 0,
        millisecond: 0,
      });
    }
    if (nowMin < endMin) {
      // Inside the window — pick from now+1 min to end
      const remaining = endMin - (nowMin + 1);
      if (remaining > 0) {
        const randomMin = nowMin + 1 + Math.floor(Math.random() * remaining);
        return now.set({
          hour: Math.floor(randomMin / 60),
          minute: randomMin % 60,
          second: 0,
          millisecond: 0,
        });
      }
      // Under a minute left in today's window — fall through to tomorrow
    }
  }

  // Window has passed today or forceTomorrow — pick within window tomorrow
  const randomMin =
    startMin + Math.floor(Math.random() * Math.max(1, endMin - startMin));
  return now
    .plus({ days: 1 })
    .set({
      hour: Math.floor(randomMin / 60),
      minute: randomMin % 60,
      second: 0,
      millisecond: 0,
    });
}

function checkDailyRunEnabled(): boolean {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'check_daily_run'")
    .get() as { value: string } | undefined;
  return row?.value !== "false";
}

function hasRunToday(jobId: number, tz: string): boolean {
  const today = DateTime.now().setZone(tz).toISODate();
  const rows = db
    .prepare(
      "SELECT ran_at FROM job_logs WHERE job_id = ? AND status = 'success' ORDER BY ran_at DESC LIMIT 5",
    )
    .all(jobId) as Array<{ ran_at: string }>;

  return rows.some((row) => {
    const dt = DateTime.fromISO(row.ran_at, { zone: "utc" }).setZone(tz);
    return dt.toISODate() === today;
  });
}

function loadEligibleJobs(): Array<{ job: Job; account: TgAccount | null }> {
  const rows = db
    .prepare(
      `
    SELECT j.*,
           a.api_id, a.api_hash, a.session_string, a.auth_status,
           a.name AS account_name, a.phone_number, a.created_at AS account_created_at
    FROM jobs j
    LEFT JOIN tg_accounts a ON j.account_id = a.id
    WHERE j.enabled = 1
      AND (
        (j.job_type != 'checkin' AND j.job_type != 'custom')
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
    } as Job,
    account:
      row.account_id != null
        ? ({
            id: row.account_id,
            name: row.account_name,
            phoneNumber: row.phone_number,
            apiId: row.api_id,
            apiHash: row.api_hash,
            sessionString: row.session_string,
            authStatus: row.auth_status,
            createdAt: row.account_created_at,
          } as TgAccount)
        : null,
  }));
}

async function executeJob(job: Job, account: TgAccount | null): Promise<void> {
  // Re-fetch job settings so changes made after scheduling take effect
  const freshJob = db.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id) as any;
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
    };
  }

  const ranAt = new Date().toISOString();
  const { lastInsertRowid: logId } = db
    .prepare(
      "INSERT INTO job_logs (job_id, ran_at, status, message) VALUES (?, ?, 'running', 'Scheduled')",
    )
    .run(job.id, ranAt);

  const detailLogs: JobDetailLog[] = [];
  const signal = registerJob(Number(logId));
  registerLiveDetail(Number(logId), detailLogs);
  try {
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
  } catch (err: any) {
    const isCancelled = err?.message === "Job cancelled";
    const detail = detailLogs.length ? JSON.stringify(detailLogs) : null;
    db.prepare(
      "UPDATE job_logs SET status = 'failed', message = ?, detail = ? WHERE id = ?",
    ).run(isCancelled ? "Cancelled" : err.message, detail, logId);
    console.error(`[scheduler] "${job.name}" failed:`, err.message);
    if (!isCancelled && account?.sessionString) {
      const cfg = getNotifyConfig();
      if (cfg.events.includes("failed")) {
        const target = cfg.username ?? "me";
        sendTgNotify(
          account,
          buildFailureMessage(job.name, job.jobType, err.message),
          target,
        ).catch((e) => console.warn("[notify] TG notification failed:", e));
      }
    }
  } finally {
    unregisterJob(Number(logId));
    clearLiveDetail(Number(logId));
    scheduleOne(job, account, true);
  }
}

function scheduleOne(
  job: Job,
  account: TgAccount | null,
  forceTomorrow = false,
): void {
  const existing = schedule.get(job.id);
  if (existing) clearTimeout(existing.timer);

  const nextRun = pickNextRun(
    job.scheduleWindowStart,
    job.scheduleWindowEnd,
    job.timezone,
    forceTomorrow,
  );
  const delayMs = Math.max(0, nextRun.toMillis() - Date.now());

  const timer = setTimeout(() => executeJob(job, account), delayMs);
  schedule.set(job.id, { job, account, nextRun: nextRun.toJSDate(), timer });

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
    if (!existing) {
      const alreadyRanToday = dailyCheckOn && hasRunToday(job.id, job.timezone);
      scheduleOne(job, account, alreadyRanToday);
    } else {
      const scheduleChanged =
        existing.job.scheduleWindowStart !== job.scheduleWindowStart ||
        existing.job.scheduleWindowEnd !== job.scheduleWindowEnd ||
        existing.job.timezone !== job.timezone ||
        existing.job.botUsername !== job.botUsername ||
        existing.job.accountId !== job.accountId;
      if (scheduleChanged) {
        const alreadyRanToday =
          dailyCheckOn && hasRunToday(job.id, job.timezone);
        scheduleOne(job, account, alreadyRanToday);
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

export function startScheduler(): void {
  console.log("[scheduler] Starting");
  refreshJobs();
  // Re-check every 5 minutes to pick up new/changed jobs
  setInterval(refreshJobs, 5 * 60 * 1000);
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
