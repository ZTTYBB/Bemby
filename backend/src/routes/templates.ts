import { Router } from 'express';
import { db } from '../db/database';
import { refreshScheduler } from '../scheduler';
import { parsePaging, parseSort, textParam } from './list-query';
import type { JobTemplate } from '../types';

const router = Router();

type TemplateRow = {
  id: number;
  name: string;
  job_type: string;
  bot_username: string;
  timezone: string;
  reply_timeout_ms: number;
  retry_max: number;
  enabled: number;
  config: string | null;
  start_command: string;
  checkin_button: string;
  created_at: string;
  run_every_days: number;
  run_every_days_max: number | null;
};

// Normalise a run-every-days range: min >= 1; max kept only when a valid integer
// strictly greater than min, else null (fixed interval).
function normalizeRunEvery(min: unknown, max: unknown): { min: number; max: number | null } {
  const lo = Math.max(1, Math.floor(Number(min ?? 1)) || 1);
  const hiNum = max == null || max === '' ? NaN : Math.floor(Number(max));
  const hi = Number.isFinite(hiNum) && hiNum > lo ? hiNum : null;
  return { min: lo, max: hi };
}

function rowToTemplate(row: TemplateRow): JobTemplate {
  return {
    id: row.id,
    name: row.name,
    jobType: row.job_type as JobTemplate['jobType'],
    botUsername: row.bot_username,
    timezone: row.timezone,
    replyTimeoutMs: row.reply_timeout_ms,
    retryMax: row.retry_max,
    enabled: Boolean(row.enabled),
    config: row.config ?? null,
    startCommand: row.start_command || '/start',
    checkinButton: row.checkin_button || '签到',
    createdAt: row.created_at,
    runEveryDays: row.run_every_days ?? 1,
    runEveryDaysMax: row.run_every_days_max ?? null,
  };
}

// Sync template fields to all linked jobs (enabled is job-specific, not synced)
function syncLinkedJobs(templateId: number, t: TemplateRow) {
  if (t.job_type === 'embywatch') {
    // Per-job credentials (username, password) must not be overwritten by the template config.
    // Update all non-config fields in bulk, then merge config per-job.
    db.prepare(`
      UPDATE jobs SET
        job_type = ?,
        bot_username = ?,
        timezone = ?,
        reply_timeout_ms = ?,
        retry_max = ?,
        start_command = ?,
        checkin_button = ?,
        run_every_days = ?,
        run_every_days_max = ?
      WHERE template_id = ?
    `).run(
      t.job_type,
      t.bot_username,
      t.timezone,
      t.reply_timeout_ms,
      t.retry_max,
      t.start_command,
      t.checkin_button,
      t.run_every_days ?? 7,
      t.run_every_days_max ?? null,
      templateId,
    );

    const tplCfg = t.config ? (JSON.parse(t.config) as Record<string, unknown>) : {};
    const linkedJobs = db.prepare('SELECT id, config FROM jobs WHERE template_id = ?').all(templateId) as Array<{ id: number; config: string | null }>;
    for (const job of linkedJobs) {
      const jobCfg = job.config ? (JSON.parse(job.config) as Record<string, unknown>) : {};
      // Spread template config first, then restore per-job credentials on top
      const merged = { ...tplCfg, username: jobCfg.username, password: jobCfg.password };
      db.prepare('UPDATE jobs SET config = ? WHERE id = ?').run(JSON.stringify(merged), job.id);
    }
  } else {
    db.prepare(`
      UPDATE jobs SET
        job_type = ?,
        bot_username = ?,
        timezone = ?,
        reply_timeout_ms = ?,
        retry_max = ?,
        config = ?,
        start_command = ?,
        checkin_button = ?,
        run_every_days = ?,
        run_every_days_max = ?
      WHERE template_id = ?
    `).run(
      t.job_type,
      t.bot_username,
      t.timezone,
      t.reply_timeout_ms,
      t.retry_max,
      t.config,
      t.start_command,
      t.checkin_button,
      t.run_every_days ?? 7,
      t.run_every_days_max ?? null,
      templateId,
    );
  }
  refreshScheduler();
}

const TEMPLATE_SORTS: Record<string, string> = {
  name: 't.name COLLATE NOCASE',
  type: 't.job_type',
  // asc shows enabled templates first, matching the previous client-side sort
  enabled: 'CASE WHEN t.enabled = 1 THEN 0 ELSE 1 END',
  botUrl: 't.bot_username COLLATE NOCASE',
  linkedJobs: 'linked_job_count',
};

router.get('/', (req, res) => {
  const query = req.query as Record<string, unknown>;
  const paging = parsePaging(query);
  const search = textParam(query.search);
  const jobType = textParam(query.jobType);
  const enabled = textParam(query.enabled);
  const sortKey = textParam(query.sortKey);

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (search) {
    // Fuzzy match against name and bot username (see db/fuzzy.ts)
    conditions.push("fuzzy_score(?, t.name || ' ' || t.bot_username) > 0");
    params.push(search);
  }
  if (jobType) {
    conditions.push('t.job_type = ?');
    params.push(jobType);
  }
  if (enabled === '1' || enabled === '0') {
    conditions.push('t.enabled = ?');
    params.push(Number(enabled));
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  // With a search active and no explicit column sort, order by match relevance
  const useRelevance = search && (!sortKey || sortKey === 'relevance');
  const orderClause = useRelevance
    ? 'search_score DESC, t.name COLLATE NOCASE'
    : parseSort(query, TEMPLATE_SORTS, TEMPLATE_SORTS.name);
  const scoreSelect = search
    ? ", fuzzy_score(?, t.name || ' ' || t.bot_username) AS search_score"
    : '';
  const scoreParams = search ? [search] : [];

  const baseSql = `
    FROM job_templates t
    LEFT JOIN jobs j ON j.template_id = t.id AND j.retired IS NULL
    ${where}
    GROUP BY t.id
  `;

  if (!paging) {
    const rows = db.prepare(`
      SELECT t.*, COUNT(j.id) AS linked_job_count ${scoreSelect}
      ${baseSql}
      ORDER BY ${orderClause}
    `).all(...scoreParams, ...params) as (TemplateRow & { linked_job_count: number })[];
    res.json(rows.map(r => ({ ...rowToTemplate(r), linkedJobCount: r.linked_job_count })));
    return;
  }

  const totalRow = db.prepare(`
    SELECT COUNT(*) AS total FROM job_templates t ${where}
  `).get(...params) as { total: number };

  const rows = db.prepare(`
    SELECT t.*, COUNT(j.id) AS linked_job_count ${scoreSelect}
    ${baseSql}
    ORDER BY ${orderClause}
    LIMIT ? OFFSET ?
  `).all(...scoreParams, ...params, paging.limit, paging.offset) as (TemplateRow & { linked_job_count: number })[];

  res.json({
    items: rows.map(r => ({ ...rowToTemplate(r), linkedJobCount: r.linked_job_count })),
    total: totalRow.total,
    page: paging.page,
    pageSize: paging.pageSize,
  });
});

router.post('/', (req, res) => {
  const {
    name,
    jobType,
    botUsername,
    timezone,
    replyTimeoutMs,
    retryMax,
    config,
    startCommand,
    checkinButton,
    runEveryDays,
    runEveryDaysMax,
  } = req.body as Record<string, any>;

  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const runEvery = normalizeRunEvery(runEveryDays, runEveryDaysMax);
  const result = db.prepare(`
    INSERT INTO job_templates
      (name, job_type, bot_username, timezone, reply_timeout_ms, retry_max, config, start_command, checkin_button, run_every_days, run_every_days_max)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    jobType ?? 'checkin',
    (botUsername as string | undefined)?.replace(/^@+/, '') ?? '',
    timezone ?? '',
    Number(replyTimeoutMs ?? 40000),
    Number(retryMax ?? 5),
    config != null ? JSON.stringify(config) : null,
    (startCommand as string | undefined)?.trim() || '/start',
    (checkinButton as string | undefined)?.trim() || '签到',
    runEvery.min,
    runEvery.max,
  );

  const row = db.prepare('SELECT * FROM job_templates WHERE id = ?').get(result.lastInsertRowid) as TemplateRow;
  res.status(201).json(rowToTemplate(row));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM job_templates WHERE id = ?').get(req.params.id) as TemplateRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const {
    name,
    jobType,
    botUsername,
    timezone,
    replyTimeoutMs,
    retryMax,
    enabled,
    config,
    startCommand,
    checkinButton,
    runEveryDays,
    runEveryDaysMax,
  } = req.body as Record<string, any>;

  const runEvery = normalizeRunEvery(
    runEveryDays !== undefined ? runEveryDays : existing.run_every_days,
    runEveryDaysMax !== undefined ? runEveryDaysMax : existing.run_every_days_max,
  );
  const updated: TemplateRow = {
    ...existing,
    name: name ?? existing.name,
    job_type: jobType ?? existing.job_type,
    bot_username: (botUsername as string | undefined)?.replace(/^@+/, '') ?? existing.bot_username,
    timezone: timezone ?? existing.timezone,
    reply_timeout_ms: Number(replyTimeoutMs ?? existing.reply_timeout_ms),
    retry_max: Number(retryMax ?? existing.retry_max),
    enabled: enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    config: config !== undefined
      ? (config != null ? JSON.stringify(config) : null)
      : existing.config,
    start_command: startCommand !== undefined
      ? ((startCommand as string).trim() || '/start')
      : existing.start_command,
    checkin_button: checkinButton !== undefined
      ? ((checkinButton as string).trim() || '签到')
      : existing.checkin_button,
    run_every_days: runEvery.min,
    run_every_days_max: runEvery.max,
  };

  db.prepare(`
    UPDATE job_templates SET
      name = ?, job_type = ?, bot_username = ?, timezone = ?,
      reply_timeout_ms = ?, retry_max = ?, enabled = ?,
      config = ?, start_command = ?, checkin_button = ?, run_every_days = ?, run_every_days_max = ?
    WHERE id = ?
  `).run(
    updated.name,
    updated.job_type,
    updated.bot_username,
    updated.timezone,
    updated.reply_timeout_ms,
    updated.retry_max,
    updated.enabled,
    updated.config,
    updated.start_command,
    updated.checkin_button,
    updated.run_every_days,
    updated.run_every_days_max,
    req.params.id,
  );

  syncLinkedJobs(Number(req.params.id), updated);

  const row = db.prepare('SELECT * FROM job_templates WHERE id = ?').get(req.params.id) as TemplateRow;
  res.json(rowToTemplate(row));
});

router.delete('/:id', (req, res) => {
  // ON DELETE SET NULL handles unlinking jobs
  db.prepare('DELETE FROM job_templates WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

// ── Bulk enable / disable linked jobs ────────────────────────────────────────

router.put('/:id/jobs/enabled', (req, res) => {
  const { enabled } = req.body as { enabled: boolean };
  db.prepare('UPDATE jobs SET enabled = ? WHERE template_id = ?').run(enabled ? 1 : 0, req.params.id);
  refreshScheduler();
  res.json({ ok: true });
});

// ── Candidate accounts (no existing job for this template) ───────────────────

router.get('/:id/available-accounts', (req, res) => {
  const rows = db.prepare(`
    SELECT id, name, phone_number, auth_status, disabled, tg_display_name
    FROM tg_accounts
    WHERE (disabled = 0 OR disabled IS NULL)
      AND id NOT IN (
        SELECT account_id FROM jobs
        WHERE template_id = ? AND account_id IS NOT NULL AND retired IS NULL
      )
    ORDER BY name COLLATE NOCASE
  `).all(req.params.id) as Array<{
    id: number; name: string; phone_number: string; auth_status: string; disabled: number; tg_display_name: string | null;
  }>;

  res.json(rows.map(r => ({
    id: r.id,
    name: r.name,
    phoneNumber: r.phone_number,
    authStatus: r.auth_status,
    tgDisplayName: r.tg_display_name ?? null,
  })));
});

// ── Bulk create jobs from template ───────────────────────────────────────────

type CreateJobEntry = {
  accountId: number;
  name: string;
  config?: Record<string, unknown>;
};

router.post('/:id/create-jobs', (req, res) => {
  const template = db.prepare('SELECT * FROM job_templates WHERE id = ?').get(req.params.id) as TemplateRow | undefined;
  if (!template) { res.status(404).json({ error: 'Not found' }); return; }

  const { jobs, scheduleWindowStart, scheduleWindowEnd } = req.body as {
    jobs: CreateJobEntry[];
    scheduleWindowStart: number;
    scheduleWindowEnd: number;
  };

  if (!Array.isArray(jobs) || !jobs.length) {
    res.status(400).json({ error: 'jobs array is required' }); return;
  }

  const createdIds: number[] = [];

  db.transaction(() => {
    for (const j of jobs) {
      // For embywatch, merge per-job credentials into template config
      let jobConfig = template.config;
      if (j.config && template.job_type === 'embywatch') {
        const tplCfg = template.config ? JSON.parse(template.config) : {};
        jobConfig = JSON.stringify({ ...tplCfg, ...j.config });
      }

      const result = db.prepare(`
        INSERT INTO jobs (
          name, account_id, job_type, bot_username,
          schedule_window_start, schedule_window_end, timezone,
          reply_timeout_ms, retry_max, enabled, config,
          start_command, checkin_button, template_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        j.name,
        j.accountId,
        template.job_type,
        template.bot_username,
        Number(scheduleWindowStart),
        Number(scheduleWindowEnd),
        template.timezone,
        template.reply_timeout_ms,
        template.retry_max,
        jobConfig,
        template.start_command,
        template.checkin_button,
        template.id,
      );
      createdIds.push(Number(result.lastInsertRowid));
    }
  })();

  refreshScheduler();
  res.status(201).json({ created: createdIds.length, ids: createdIds });
});

export default router;
