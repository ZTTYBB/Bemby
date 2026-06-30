import { Router } from 'express';
import { db } from '../db/database';
import { refreshScheduler } from '../scheduler';

const router = Router();

type AccountRow = {
  id: number;
  name: string;
  phone_number: string;
  api_id: number;
  api_hash: string;
  session_string: string | null;
  auth_status: string;
  proxy_id: string | null;
};

type JobRow = {
  id: number;
  account_id: number | null;
  template_id: number | null;
  name: string;
  job_type: string;
  bot_username: string;
  schedule_window_start: number;
  schedule_window_end: number;
  timezone: string;
  reply_timeout_ms: number;
  retry_max: number;
  enabled: number;
  config: string | null;
  start_command: string;
  checkin_button: string;
};

type TemplateRow = {
  id: number;
  name: string;
  job_type: string;
  bot_username: string;
  timezone: string;
  reply_timeout_ms: number;
  retry_max: number;
  config: string | null;
  start_command: string;
  checkin_button: string;
};

type SettingRow = { key: string; value: string };

export type ExportPayload = {
  version: '1';
  exportedAt: string;
  accounts: Array<{
    name: string;
    phoneNumber: string;
    apiId: number;
    apiHash: string;
    sessionString: string | null;
    authStatus: string;
    proxyId?: string | null;
  }>;
  templates?: Array<{
    name: string;
    jobType: string;
    botUsername: string;
    timezone: string;
    replyTimeoutMs: number;
    retryMax: number;
    config: string | null;
    startCommand: string;
    checkinButton: string;
  }>;
  jobs: Array<{
    /** Index into the accounts array; null for jobs that don't require an account */
    accountIndex: number | null;
    /** Index into the templates array; null if not linked to a template */
    templateIndex?: number | null;
    name: string;
    jobType: string;
    botUsername: string;
    scheduleWindowStart: number;
    scheduleWindowEnd: number;
    timezone: string;
    replyTimeoutMs: number;
    retryMax: number;
    enabled: boolean;
    config: string | null;
    startCommand: string;
    checkinButton: string;
  }>;
  settings: Record<string, string>;
};

router.get('/export', (_req, res) => {
  const accounts = db.prepare('SELECT * FROM tg_accounts ORDER BY id').all() as AccountRow[];
  const templates = db.prepare('SELECT * FROM job_templates ORDER BY id').all() as TemplateRow[];
  const jobs = db.prepare('SELECT * FROM jobs ORDER BY id').all() as JobRow[];
  const settings = db.prepare('SELECT key, value FROM settings').all() as SettingRow[];

  const accountIdToIndex = new Map(accounts.map((a, i) => [a.id, i]));
  const templateIdToIndex = new Map(templates.map((t, i) => [t.id, i]));

  const payload: ExportPayload = {
    version: '1',
    exportedAt: new Date().toISOString(),
    accounts: accounts.map(a => ({
      name: a.name,
      phoneNumber: a.phone_number,
      apiId: a.api_id,
      apiHash: a.api_hash,
      sessionString: a.session_string,
      authStatus: a.auth_status,
      proxyId: a.proxy_id ?? null,
    })),
    templates: templates.map(t => ({
      name: t.name,
      jobType: t.job_type,
      botUsername: t.bot_username,
      timezone: t.timezone,
      replyTimeoutMs: t.reply_timeout_ms,
      retryMax: t.retry_max,
      config: t.config,
      startCommand: t.start_command,
      checkinButton: t.checkin_button,
    })),
    jobs: jobs.map(j => ({
      accountIndex: j.account_id != null ? (accountIdToIndex.get(j.account_id) ?? null) : null,
      templateIndex: j.template_id != null ? (templateIdToIndex.get(j.template_id) ?? null) : null,
      name: j.name,
      jobType: j.job_type,
      botUsername: j.bot_username,
      scheduleWindowStart: j.schedule_window_start,
      scheduleWindowEnd: j.schedule_window_end,
      timezone: j.timezone,
      replyTimeoutMs: j.reply_timeout_ms,
      retryMax: j.retry_max,
      enabled: j.enabled === 1,
      config: j.config,
      startCommand: j.start_command,
      checkinButton: j.checkin_button,
    })),
    settings: Object.fromEntries(settings.map(s => [s.key, s.value])),
  };

  res.json(payload);
});

router.post('/import', (req, res) => {
  const { data, mode } = req.body as { data: ExportPayload; mode: 'merge' | 'replace' };

  if (!data || data.version !== '1') {
    res.status(400).json({ error: 'Invalid or unsupported export file' });
    return;
  }

  if (!Array.isArray(data.accounts) || !Array.isArray(data.jobs)) {
    res.status(400).json({ error: 'Malformed export file: missing accounts or jobs' });
    return;
  }

  const results = { accountsImported: 0, accountsSkipped: 0, templatesImported: 0, jobsImported: 0, settingsUpdated: 0 };

  db.transaction(() => {
    if (mode === 'replace') {
      // Jobs must be deleted first due to FK references
      db.prepare('DELETE FROM jobs').run();
      db.prepare('DELETE FROM job_templates').run();
      db.prepare('DELETE FROM tg_accounts').run();
    }

    // Import accounts and build accountIndex -> new db id mapping
    const accountIndexToId = new Map<number, number>();

    for (let i = 0; i < data.accounts.length; i++) {
      const a = data.accounts[i];

      if (mode === 'merge') {
        const existing = db.prepare('SELECT id FROM tg_accounts WHERE phone_number = ?').get(a.phoneNumber) as { id: number } | undefined;
        if (existing) {
          accountIndexToId.set(i, existing.id);
          results.accountsSkipped++;
          continue;
        }
      }

      const result = db.prepare(
        `INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, session_string, auth_status, proxy_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(a.name, a.phoneNumber, a.apiId, a.apiHash, a.sessionString ?? null, a.authStatus ?? 'unauthenticated', a.proxyId ?? null);

      accountIndexToId.set(i, result.lastInsertRowid as number);
      results.accountsImported++;
    }

    // Import templates and build templateIndex -> new db id mapping
    const templateIndexToId = new Map<number, number>();

    if (Array.isArray(data.templates)) {
      for (let i = 0; i < data.templates.length; i++) {
        const t = data.templates[i];

        if (mode === 'merge') {
          const existing = db.prepare('SELECT id FROM job_templates WHERE name = ?').get(t.name) as { id: number } | undefined;
          if (existing) {
            templateIndexToId.set(i, existing.id);
            continue;
          }
        }

        const result = db.prepare(
          `INSERT INTO job_templates
             (name, job_type, bot_username, timezone, reply_timeout_ms, retry_max, config, start_command, checkin_button)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          t.name,
          t.jobType ?? 'checkin',
          t.botUsername ?? '',
          t.timezone ?? 'Australia/Sydney',
          t.replyTimeoutMs ?? 40000,
          t.retryMax ?? 5,
          t.config ?? null,
          t.startCommand ?? '/start',
          t.checkinButton ?? '签到',
        );

        templateIndexToId.set(i, result.lastInsertRowid as number);
        results.templatesImported++;
      }
    }

    // Import jobs
    for (const j of data.jobs) {
      const resolvedAccountId = j.accountIndex != null ? (accountIndexToId.get(j.accountIndex) ?? null) : null;
      const resolvedTemplateId = j.templateIndex != null ? (templateIndexToId.get(j.templateIndex) ?? null) : null;

      db.prepare(
        `INSERT INTO jobs
           (account_id, template_id, name, job_type, bot_username, schedule_window_start, schedule_window_end,
            timezone, reply_timeout_ms, retry_max, enabled, config, start_command, checkin_button)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        resolvedAccountId,
        resolvedTemplateId,
        j.name,
        j.jobType ?? 'checkin',
        j.botUsername,
        j.scheduleWindowStart ?? 1400,
        j.scheduleWindowEnd ?? 1600,
        j.timezone ?? 'Australia/Sydney',
        j.replyTimeoutMs ?? 40000,
        j.retryMax ?? 5,
        j.enabled ? 1 : 0,
        j.config ?? null,
        j.startCommand ?? '/start',
        j.checkinButton ?? '签到',
      );
      results.jobsImported++;
    }

    // Merge settings
    if (data.settings && typeof data.settings === 'object') {
      const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      for (const [key, value] of Object.entries(data.settings)) {
        if (typeof value === 'string') { stmt.run(key, value); results.settingsUpdated++; }
      }
    }
  })();

  refreshScheduler();
  res.json({ message: 'Import complete', ...results });
});

export default router;
