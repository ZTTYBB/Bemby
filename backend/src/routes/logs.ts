import { Router } from 'express';
import { db } from '../db/database';
import { cancelJob, isJobRunning, getLiveDetail } from '../jobs/cancellation';

const router = Router();

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`
    SELECT l.id, l.job_id, l.ran_at, l.status, l.message, l.detail,
           j.name AS job_name, j.job_type,
           a.name AS account_name
    FROM job_logs l
    LEFT JOIN jobs j ON l.job_id = j.id
    LEFT JOIN tg_accounts a ON j.account_id = a.id
    WHERE l.id = ?
  `).get(id) as any;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  const liveDetail = getLiveDetail(id);
  res.json({
    id: row.id,
    jobId: row.job_id,
    jobName: row.job_name,
    jobType: row.job_type ?? null,
    accountName: row.account_name,
    ranAt: row.ran_at,
    status: row.status,
    message: row.message,
    detail: liveDetail ?? (row.detail ? JSON.parse(row.detail) : null),
  });
});

router.get('/', (req, res) => {
  const { jobId, limit = '50', offset = '0', showRetired = '0' } = req.query as Record<string, string>;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (jobId) { conditions.push('l.job_id = ?'); params.push(Number(jobId)); }
  if (showRetired !== '1') { conditions.push('l.retired = 0'); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(Number(limit), Number(offset));

  const rows = db.prepare(`
    SELECT l.id, l.job_id, l.ran_at, l.status, l.message, l.retired,
           j.name AS job_name, j.job_type,
           a.name AS account_name
    FROM job_logs l
    LEFT JOIN jobs j ON l.job_id = j.id
    LEFT JOIN tg_accounts a ON j.account_id = a.id
    ${where}
    ORDER BY l.ran_at DESC
    LIMIT ? OFFSET ?
  `).all(...params) as any[];

  res.json(rows.map(r => ({
    id: r.id,
    jobId: r.job_id,
    jobName: r.job_name,
    jobType: r.job_type ?? null,
    accountName: r.account_name,
    ranAt: r.ran_at,
    status: r.status,
    message: r.message,
    retired: r.retired === 1,
  })));
});

router.patch('/:id/retire', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT retired FROM job_logs WHERE id = ?').get(id) as { retired: number } | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  const newVal = row.retired ? 0 : 1;
  db.prepare('UPDATE job_logs SET retired = ? WHERE id = ?').run(newVal, id);
  res.json({ retired: newVal === 1 });
});

router.post('/:id/cancel', (req, res) => {
  const logId = Number(req.params.id);
  if (!isJobRunning(logId)) {
    res.status(404).json({ error: 'No running job found for this log entry' });
    return;
  }
  cancelJob(logId);
  res.json({ message: 'Cancel signal sent' });
});

export default router;
