import { Router } from "express";
import { db, getDefaultTgApiCredentials } from "../db/database";
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
import { testEmbyConnection } from "../jobs/embywatch";
import { parsePaging, parseSort, textParam, escapeLike } from "./list-query";

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
  run_every_days_max: number | null;
  retired: string | null;
  account_name?: string;
};

type AccountRow = {
  id: number;
  name: string;
  phone_number: string;
  api_id: number | null;
  api_hash: string | null;
  session_string: string | null;
  auth_status: string;
  proxy_id: string | null;
  disabled: number;
  app_client_id: string | null;
  created_at: string;
};

/** Credentials are resolved as a pair: the account's own if complete, else the global defaults. */
function rowToAccount(row: AccountRow): TgAccount {
  const ownCredentials =
    row.api_id && row.api_hash
      ? { apiId: row.api_id, apiHash: row.api_hash }
      : null;
  const credentials = ownCredentials ?? getDefaultTgApiCredentials();
  return {
    id: row.id,
    name: row.name,
    phoneNumber: row.phone_number,
    apiId: credentials?.apiId ?? null,
    apiHash: credentials?.apiHash ?? null,
    sessionString: row.session_string,
    authStatus: row.auth_status as TgAccount["authStatus"],
    proxyId: row.proxy_id ?? null,
    disabled: Boolean(row.disabled),
    appClientId: row.app_client_id ?? null,
    createdAt: row.created_at,
  };
}

// Normalise a run-every-days range: min is clamped to >= 1; max is kept only
// when it is a valid integer strictly greater than min, otherwise null (fixed).
export function normalizeRunEvery(min: unknown, max: unknown): { min: number; max: number | null } {
  const lo = Math.max(1, Math.floor(Number(min ?? 1)) || 1);
  const hiNum = max == null || max === "" ? NaN : Math.floor(Number(max));
  const hi = Number.isFinite(hiNum) && hiNum > lo ? hiNum : null;
  return { min: lo, max: hi };
}

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
    runEveryDaysMax: row.run_every_days_max ?? null,
    retired: row.retired ?? null,
  };
}

const JOB_SORTS: Record<string, string> = {
  name: "j.name COLLATE NOCASE",
  account: "account_name COLLATE NOCASE",
  type: "j.job_type",
  botUrl: "j.bot_username COLLATE NOCASE",
  window: "j.schedule_window_start",
  // asc shows enabled jobs first, matching the previous client-side sort
  enabled: "CASE WHEN j.enabled = 1 THEN 0 ELSE 1 END",
};

router.get("/", (req, res) => {
  const query = req.query as Record<string, unknown>;
  const paging = parsePaging(query);
  const search = textParam(query.search);
  const jobType = textParam(query.jobType);
  const accountId = textParam(query.accountId);
  const botUsername = textParam(query.botUsername);
  const templateId = textParam(query.templateId);
  const enabled = textParam(query.enabled);

  const conditions: string[] = ["j.retired IS NULL"];
  const params: (string | number)[] = [];

  if (search) {
    conditions.push("j.name LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(search)}%`);
  }
  if (jobType) {
    conditions.push("j.job_type = ?");
    params.push(jobType);
  }
  if (accountId) {
    const parsed = Number(accountId);
    if (!Number.isInteger(parsed)) {
      res.status(400).json({ error: "Invalid accountId" });
      return;
    }
    conditions.push("j.account_id = ?");
    params.push(parsed);
  }
  if (botUsername) {
    conditions.push("j.bot_username = ?");
    params.push(botUsername);
  }
  if (templateId) {
    const parsed = Number(templateId);
    if (!Number.isInteger(parsed)) {
      res.status(400).json({ error: "Invalid templateId" });
      return;
    }
    conditions.push("j.template_id = ?");
    params.push(parsed);
  }
  if (enabled === "1" || enabled === "0") {
    conditions.push("j.enabled = ?");
    params.push(Number(enabled));
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const orderClause = parseSort(query, JOB_SORTS, JOB_SORTS.name);
  const baseSql = `
    FROM jobs j
    LEFT JOIN tg_accounts a ON j.account_id = a.id
    ${where}
  `;

  if (!paging) {
    const rows = db
      .prepare(`SELECT j.*, a.name AS account_name ${baseSql} ORDER BY ${orderClause}`)
      .all(...params) as JobRow[];
    res.json(rows.map(rowToJob));
    return;
  }

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total ${baseSql}`)
    .get(...params) as { total: number };

  const rows = db
    .prepare(`
      SELECT j.*, a.name AS account_name
      ${baseSql}
      ORDER BY ${orderClause}
      LIMIT ? OFFSET ?
    `)
    .all(...params, paging.limit, paging.offset) as JobRow[];

  // Facets let the client build filter dropdowns without loading every row
  const botUsernames = db
    .prepare(`
      SELECT DISTINCT bot_username FROM jobs
      WHERE retired IS NULL AND template_id IS NULL AND bot_username != ''
      ORDER BY bot_username COLLATE NOCASE
    `)
    .all() as Array<{ bot_username: string }>;
  const templatesInUse = db
    .prepare(`
      SELECT DISTINCT t.id, t.name FROM jobs j
      JOIN job_templates t ON j.template_id = t.id
      WHERE j.retired IS NULL
      ORDER BY t.name COLLATE NOCASE
    `)
    .all() as Array<{ id: number; name: string }>;

  res.json({
    items: rows.map(rowToJob),
    total: totalRow.total,
    page: paging.page,
    pageSize: paging.pageSize,
    facets: {
      botUsernames: botUsernames.map((r) => r.bot_username),
      templates: templatesInUse,
    },
  });
});

// Verify Emby server reachability and credentials without creating a job
router.post("/test-emby", async (req, res) => {
  const { serverUrl, username, password, userAgent, proxyId } = req.body as Record<
    string,
    string | undefined
  >;
  if (!serverUrl || !username || !password) {
    res
      .status(400)
      .json({ error: "serverUrl, username and password are required" });
    return;
  }
  if (!/^https?:\/\//i.test(serverUrl)) {
    res
      .status(400)
      .json({ error: "serverUrl must start with http:// or https://" });
    return;
  }
  const result = await testEmbyConnection(serverUrl, {
    username,
    password,
    userAgent,
    proxyId,
  });
  res.json(result);
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
    runEveryDaysMax,
  } = req.body as Record<string, any>;

  const resolvedType = jobType ?? "checkin";
  const needsAccount =
    resolvedType === "checkin" ||
    resolvedType === "custom" ||
    resolvedType === "autoreg";
  if (!name || (needsAccount && !accountId) || !botUsername) {
    res.status(400).json({
      error: "name and botUsername are required; accountId is required for checkin, custom and autoreg jobs",
    });
    return;
  }

  const runEvery = normalizeRunEvery(runEveryDays, runEveryDaysMax);
  const result = db
    .prepare(
      `
    INSERT INTO jobs
      (name, account_id, job_type, bot_username, schedule_window_start, schedule_window_end,
       timezone, reply_timeout_ms, retry_max, enabled, config, start_command, checkin_button, template_id, run_every_days, run_every_days_max)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      name,
      accountId ? Number(accountId) : null,
      resolvedType,
      (botUsername as string).replace(/^@+/, ""),
      Number(scheduleWindowStart ?? 1400),
      Number(scheduleWindowEnd ?? 1600),
      timezone ?? "",
      Number(replyTimeoutMs ?? 40000),
      Number(retryMax ?? 5),
      enabled !== false ? 1 : 0,
      config != null ? JSON.stringify(config) : null,
      (startCommand as string | undefined)?.trim() || "/start",
      (checkinButton as string | undefined)?.trim() || "签到",
      templateId ? Number(templateId) : null,
      runEvery.min,
      runEvery.max,
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
    runEveryDaysMax,
  } = req.body as Record<string, any>;

  // When linked to a template, template-controlled fields are read-only
  const isLinked = existing.template_id != null && templateId === undefined;
  const resolvedTemplateId = templateId !== undefined
    ? (templateId ? Number(templateId) : null)
    : existing.template_id;

  const updatedType = isLinked ? existing.job_type : (jobType ?? existing.job_type);
  const runEvery = normalizeRunEvery(
    runEveryDays !== undefined ? runEveryDays : existing.run_every_days,
    runEveryDaysMax !== undefined ? runEveryDaysMax : existing.run_every_days_max,
  );
  db.prepare(
    `
    UPDATE jobs SET
      name = ?, account_id = ?, job_type = ?, bot_username = ?,
      schedule_window_start = ?, schedule_window_end = ?, timezone = ?,
      reply_timeout_ms = ?, retry_max = ?, enabled = ?, config = ?,
      start_command = ?, checkin_button = ?, template_id = ?, run_every_days = ?, run_every_days_max = ?
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
    runEvery.min,
    runEvery.max,
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
  db.prepare("UPDATE jobs SET retired = datetime('now') WHERE id = ?").run(req.params.id);
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

  if (job.jobType === "checkin" || job.jobType === "custom" || job.jobType === "autoreg") {
    const accountRow = db
      .prepare("SELECT * FROM tg_accounts WHERE id = ?")
      .get(jobRow.account_id) as AccountRow | undefined;
    if (!accountRow?.session_string) {
      res.status(400).json({ error: "Account is not authenticated" });
      return;
    }
    account = rowToAccount(accountRow);
    if (!account.apiId || !account.apiHash) {
      res.status(400).json({
        error:
          "No API credentials available for this account. Add credentials to the account or configure global defaults in Settings.",
      });
      return;
    }
  } else if (job.accountId) {
    // Optional linked account (e.g. embywatch) — used for notifications only; don't block if not authenticated
    const accountRow = db
      .prepare("SELECT * FROM tg_accounts WHERE id = ?")
      .get(job.accountId) as AccountRow | undefined;
    if (accountRow?.session_string) {
      account = rowToAccount(accountRow);
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
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const isCancelled = message === "Job cancelled";
      const detail = detailLogs.length ? JSON.stringify(detailLogs) : null;
      db.prepare(
        "UPDATE job_logs SET status = 'failed', message = ?, detail = ? WHERE id = ?",
      ).run(isCancelled ? "Cancelled" : message, detail, logId);
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
    })
    .finally(() => { unregisterJob(Number(logId)); clearLiveDetail(Number(logId)); });
});

export default router;
