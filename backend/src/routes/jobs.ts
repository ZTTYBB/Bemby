import { Router } from "express";
import { db } from "../db/database";
import { runJob, type JobDetailLog } from "../jobs/runner";
import {
  sendTgNotify,
  buildFailureMessage,
  buildSuccessMessage,
  getNotifyConfig,
} from "../jobs/notify";
import { refreshScheduler } from "../scheduler";
import type { Job, TgAccount } from "../types";
import { registerJob, unregisterJob, registerLiveDetail, clearLiveDetail } from "../jobs/cancellation";

const router = Router();

type JobRow = {
  id: number;
  name: string;
  account_id: number | null;
  job_type: string;
  bot_username: string;
  schedule_window_start: number;
  schedule_window_end: number;
  timezone: string;
  reply_timeout_ms: number;
  retry_max: number;
  enabled: number;
  created_at: string;
  config: string | null;
  start_command: string;
  checkin_button: string;
  template_id: number | null;
  run_every_days: number;
  account_name?: string;
};

type AccountRow = {
  id: number;
  name: string;
  phone_number: string;
  api_id: number;
  api_hash: string;
  session_string: string | null;
  auth_status: string;
  proxy_id: string | null;
  disabled: number;
  app_client_id: string | null;
  created_at: string;
};

function rowToJob(row: JobRow): Job & { accountName?: string } {
  return {
    id: row.id,
    name: row.name,
    accountId: row.account_id ?? null,
    accountName: row.account_name,
    jobType: row.job_type as Job["jobType"],
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
    templateId: row.template_id ?? null,
    runEveryDays: row.run_every_days ?? 1,
  };
}

router.get("/", (_req, res) => {
  const rows = db
    .prepare(
      `
    SELECT j.*, a.name AS account_name
    FROM jobs j
    LEFT JOIN tg_accounts a ON j.account_id = a.id
    ORDER BY j.name COLLATE NOCASE
  `,
    )
    .all() as JobRow[];
  res.json(rows.map(rowToJob));
});

router.post("/", (req, res) => {
  const {
    name,
    accountId,
    jobType,
    botUsername,
    scheduleWindowStart,
    scheduleWindowEnd,
    timezone,
    replyTimeoutMs,
    retryMax,
    enabled,
    config,
    startCommand,
    checkinButton,
    templateId,
    runEveryDays,
  } = req.body as Record<string, any>;

  const resolvedType = jobType ?? "checkin";
  const needsAccount = resolvedType === "checkin" || resolvedType === "custom";
  if (!name || (needsAccount && !accountId) || !botUsername) {
    res.status(400).json({
      error: "name and botUsername are required; accountId is required for checkin and custom jobs",
    });
    return;
  }

  const result = db
    .prepare(
      `
    INSERT INTO jobs
      (name, account_id, job_type, bot_username, schedule_window_start, schedule_window_end,
       timezone, reply_timeout_ms, retry_max, enabled, config, start_command, checkin_button, template_id, run_every_days)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      name,
      accountId ? Number(accountId) : null,
      resolvedType,
      (botUsername as string).replace(/^@+/, ""),
      Number(scheduleWindowStart ?? 1400),
      Number(scheduleWindowEnd ?? 1600),
      timezone ?? "Australia/Sydney",
      Number(replyTimeoutMs ?? 40000),
      Number(retryMax ?? 5),
      enabled !== false ? 1 : 0,
      config != null ? JSON.stringify(config) : null,
      (startCommand as string | undefined)?.trim() || "/start",
      (checkinButton as string | undefined)?.trim() || "签到",
      templateId ? Number(templateId) : null,
      Math.max(1, Number(runEveryDays ?? 1)),
    );

  const row = db
    .prepare(
      "SELECT j.*, a.name AS account_name FROM jobs j LEFT JOIN tg_accounts a ON j.account_id = a.id WHERE j.id = ?",
    )
    .get(result.lastInsertRowid) as JobRow;
  refreshScheduler();
  res.status(201).json(rowToJob(row));
});

router.put("/:id", (req, res) => {
  const existing = db
    .prepare("SELECT * FROM jobs WHERE id = ?")
    .get(req.params.id) as JobRow | undefined;
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const {
    name,
    accountId,
    jobType,
    botUsername,
    scheduleWindowStart,
    scheduleWindowEnd,
    timezone,
    replyTimeoutMs,
    retryMax,
    enabled,
    config,
    startCommand,
    checkinButton,
    templateId,
    runEveryDays,
  } = req.body as Record<string, any>;

  // When linked to a template, template-controlled fields are read-only
  const isLinked = existing.template_id != null && templateId === undefined;
  const resolvedTemplateId = templateId !== undefined
    ? (templateId ? Number(templateId) : null)
    : existing.template_id;

  const updatedType = isLinked ? existing.job_type : (jobType ?? existing.job_type);
  db.prepare(
    `
    UPDATE jobs SET
      name = ?, account_id = ?, job_type = ?, bot_username = ?,
      schedule_window_start = ?, schedule_window_end = ?, timezone = ?,
      reply_timeout_ms = ?, retry_max = ?, enabled = ?, config = ?,
      start_command = ?, checkin_button = ?, template_id = ?, run_every_days = ?
    WHERE id = ?
  `,
  ).run(
    name ?? existing.name,
    accountId !== undefined ? (accountId ? Number(accountId) : null) : (existing.account_id ?? null),
    updatedType,
    isLinked ? existing.bot_username : ((botUsername as string | undefined)?.replace(/^@+/, "") ?? existing.bot_username),
    Number(scheduleWindowStart ?? existing.schedule_window_start),
    Number(scheduleWindowEnd ?? existing.schedule_window_end),
    isLinked ? existing.timezone : (timezone ?? existing.timezone),
    isLinked ? existing.reply_timeout_ms : Number(replyTimeoutMs ?? existing.reply_timeout_ms),
    isLinked ? existing.retry_max : Number(retryMax ?? existing.retry_max),
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    // embywatch template-linked jobs store credentials in the job; allow config updates
    (isLinked && existing.job_type !== 'embywatch') ? existing.config : (config !== undefined
      ? config != null
        ? JSON.stringify(config)
        : null
      : existing.config),
    isLinked ? existing.start_command : (startCommand !== undefined ? ((startCommand as string).trim() || "/start") : existing.start_command),
    isLinked ? existing.checkin_button : (checkinButton !== undefined ? ((checkinButton as string).trim() || "签到") : existing.checkin_button),
    resolvedTemplateId,
    Math.max(1, Number(runEveryDays ?? existing.run_every_days ?? 1)),
    req.params.id,
  );

  const row = db
    .prepare(
      "SELECT j.*, a.name AS account_name FROM jobs j LEFT JOIN tg_accounts a ON j.account_id = a.id WHERE j.id = ?",
    )
    .get(req.params.id) as JobRow;
  refreshScheduler();
  res.json(rowToJob(row));
});

router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM jobs WHERE id = ?").run(req.params.id);
  refreshScheduler();
  res.status(204).send();
});

// Manual trigger
router.post("/:id/run", async (req, res) => {
  const jobRow = db
    .prepare("SELECT * FROM jobs WHERE id = ?")
    .get(req.params.id) as JobRow | undefined;
  if (!jobRow) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const job = rowToJob(jobRow);
  let account: TgAccount | null = null;

  if (job.jobType === "checkin" || job.jobType === "custom") {
    const accountRow = db
      .prepare("SELECT * FROM tg_accounts WHERE id = ?")
      .get(jobRow.account_id) as AccountRow | undefined;
    if (!accountRow?.session_string) {
      res.status(400).json({ error: "Account is not authenticated" });
      return;
    }
    account = {
      id: accountRow.id,
      name: accountRow.name,
      phoneNumber: accountRow.phone_number,
      apiId: accountRow.api_id,
      apiHash: accountRow.api_hash,
      sessionString: accountRow.session_string,
      authStatus: accountRow.auth_status as TgAccount["authStatus"],
      proxyId: accountRow.proxy_id ?? null,
      disabled: Boolean(accountRow.disabled),
      appClientId: accountRow.app_client_id ?? null,
      createdAt: accountRow.created_at,
    };
  } else if (job.accountId) {
    // Optional linked account (e.g. embywatch) — used for notifications only; don't block if not authenticated
    const accountRow = db
      .prepare("SELECT * FROM tg_accounts WHERE id = ?")
      .get(job.accountId) as AccountRow | undefined;
    if (accountRow?.session_string) {
      account = {
        id: accountRow.id,
        name: accountRow.name,
        phoneNumber: accountRow.phone_number,
        apiId: accountRow.api_id,
        apiHash: accountRow.api_hash,
        sessionString: accountRow.session_string,
        authStatus: accountRow.auth_status as TgAccount["authStatus"],
        proxyId: accountRow.proxy_id ?? null,
        disabled: Boolean(accountRow.disabled),
        appClientId: accountRow.app_client_id ?? null,
        createdAt: accountRow.created_at,
      };
    }
  }

  const ranAt = new Date().toISOString();
  const logResult = db
    .prepare(
      "INSERT INTO job_logs (job_id, ran_at, status, message, source) VALUES (?, ?, 'running', 'Manual run', 'manual')",
    )
    .run(job.id, ranAt);
  const logId = logResult.lastInsertRowid;

  res.json({ message: "Job triggered", logId });

  const detailLogs: JobDetailLog[] = [];
  const signal = registerJob(Number(logId));
  registerLiveDetail(Number(logId), detailLogs);
  runJob(job, account, detailLogs, signal)
    .then(() => {
      const detail = detailLogs.length ? JSON.stringify(detailLogs) : null;
      db.prepare(
        "UPDATE job_logs SET status = 'success', message = 'Completed', detail = ? WHERE id = ?",
      ).run(detail, logId);
      if (account?.sessionString) {
        const cfg = getNotifyConfig();
        if (cfg.events.includes("success") && cfg.username) {
          sendTgNotify(
            account,
            buildSuccessMessage(job.name, job.jobType),
            cfg.username,
          ).catch((e) => console.warn("[notify] TG notification failed:", e));
        }
      }
    })
    .catch((err: Error) => {
      const isCancelled = err.message === "Job cancelled";
      const detail = detailLogs.length ? JSON.stringify(detailLogs) : null;
      db.prepare(
        "UPDATE job_logs SET status = 'failed', message = ?, detail = ? WHERE id = ?",
      ).run(isCancelled ? "Cancelled" : err.message, detail, logId);
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
    })
    .finally(() => { unregisterJob(Number(logId)); clearLiveDetail(Number(logId)); });
});

export default router;
