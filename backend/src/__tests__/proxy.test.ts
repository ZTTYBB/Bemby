// Unit tests for proxy resolution and TgProxy parsing.
// These guard against regressions in how proxies are selected and passed
// to Telegram runners (SOCKS5) vs Emby HTTP clients.

vi.mock('../db/database', () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
    }),
  },
}));
vi.mock('../jobs/checkin', () => ({ runCheckin: vi.fn(), CheckinError: class CheckinError extends Error {} }));
vi.mock('../jobs/embywatch', () => ({ runEmbywatch: vi.fn() }));
vi.mock('../jobs/custom', () => ({ runCustom: vi.fn(), CustomJobError: class CustomJobError extends Error {} }));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '../db/database';
import { runCheckin } from '../jobs/checkin';
import { runCustom } from '../jobs/custom';
import { parseTgProxy, runJob } from '../jobs/runner';
import type { Job, TgAccount } from '../types';

// ---------------------------------------------------------------------------
// parseTgProxy
// ---------------------------------------------------------------------------

describe('parseTgProxy', () => {
  it('returns undefined for undefined input', () => {
    expect(parseTgProxy(undefined)).toBeUndefined();
  });

  it('returns undefined for an HTTP proxy URL', () => {
    expect(parseTgProxy('http://proxy.example.com:3128')).toBeUndefined();
  });

  it('returns undefined for an HTTPS proxy URL', () => {
    expect(parseTgProxy('https://proxy.example.com:3128')).toBeUndefined();
  });

  it('parses a bare socks5 URL', () => {
    const result = parseTgProxy('socks5://proxy.example.com:1080');
    expect(result).toEqual({ ip: 'proxy.example.com', port: 1080, socksType: 5, username: undefined, password: undefined });
  });

  it('parses a socks4 URL with socksType 4', () => {
    const result = parseTgProxy('socks4://proxy.example.com:1080');
    expect(result).toEqual({ ip: 'proxy.example.com', port: 1080, socksType: 4, username: undefined, password: undefined });
  });

  it('parses socks5 with username and password', () => {
    const result = parseTgProxy('socks5://alice:secret@proxy.example.com:1080');
    expect(result).toMatchObject({ ip: 'proxy.example.com', port: 1080, socksType: 5, username: 'alice', password: 'secret' });
  });

  it('defaults port to 1080 when omitted', () => {
    const result = parseTgProxy('socks5://proxy.example.com');
    expect(result?.port).toBe(1080);
  });

  it('returns undefined for a malformed URL', () => {
    expect(parseTgProxy('not-a-url')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Proxy resolution through runJob
// ---------------------------------------------------------------------------

function makeCheckinJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 1, name: 'Job', accountId: 1, jobType: 'checkin',
    botUsername: 'bot', scheduleWindowStart: 0, scheduleWindowEnd: 0,
    timezone: 'UTC', replyTimeoutMs: 5000, retryMax: 1, enabled: true,
    createdAt: '', config: null, startCommand: '/start', checkinButton: '签到', runEveryDays: 1,
    ...overrides,
  };
}

function makeAccount(): TgAccount {
  return { id: 1, name: 'A', phoneNumber: '+1', apiId: 1, apiHash: 'h', sessionString: 'sess', authStatus: 'authenticated', proxyId: null, disabled: false, appClientId: null, createdAt: '' };
}

const stubLog = { attempt: 1, commandSent: '/start', hasMedia: false, commandResponseHtml: '', availableButtons: [] };

beforeEach(() => vi.clearAllMocks());

describe('runJob proxy resolution — checkin', () => {
  it('passes no proxy when job has no proxyId', async () => {
    vi.mocked(runCheckin).mockResolvedValue(stubLog as any);
    vi.mocked(db.prepare).mockReturnValue({ get: vi.fn().mockReturnValue(undefined) } as any);

    await runJob(makeCheckinJob(), makeAccount());

    const args = vi.mocked(runCheckin).mock.calls[0];
    // 11th argument (index 10) is the TgProxy
    expect(args[10]).toBeUndefined();
  });

  it('resolves proxy from job config and passes TgProxy to runCheckin', async () => {
    vi.mocked(runCheckin).mockResolvedValue(stubLog as any);

    vi.mocked(db.prepare).mockReturnValue({
      get: vi.fn().mockReturnValue({ value: JSON.stringify([{ id: 'px1', name: 'P', url: 'socks5://proxy.local:1080' }]) }),
    } as any);

    const job = makeCheckinJob({ config: JSON.stringify({ proxyId: 'px1' }) });
    await runJob(job, makeAccount());

    const tgProxy = vi.mocked(runCheckin).mock.calls[0][10];
    expect(tgProxy).toMatchObject({ ip: 'proxy.local', port: 1080, socksType: 5 });
  });

  it('resolves proxy from template config in preference to job config', async () => {
    vi.mocked(runCheckin).mockResolvedValue(stubLog as any);

    vi.mocked(db.prepare).mockImplementation((sql: string) => ({
      get: vi.fn().mockImplementation((arg: unknown) => {
        if (sql.includes('job_templates')) return { config: JSON.stringify({ proxyId: 'tpl-px' }) };
        // settings lookup
        return { value: JSON.stringify([
          { id: 'tpl-px', name: 'Template proxy', url: 'socks5://tpl.proxy:1080' },
          { id: 'job-px', name: 'Job proxy', url: 'socks5://job.proxy:1080' },
        ]) };
      }),
    } as any));

    const job = makeCheckinJob({ templateId: 42, config: JSON.stringify({ proxyId: 'job-px' }) });
    await runJob(job, makeAccount());

    const tgProxy = vi.mocked(runCheckin).mock.calls[0][10];
    expect(tgProxy).toMatchObject({ ip: 'tpl.proxy' });
  });

  it('does not pass a TgProxy when the proxy URL is HTTP (not SOCKS)', async () => {
    vi.mocked(runCheckin).mockResolvedValue(stubLog as any);

    vi.mocked(db.prepare).mockReturnValue({
      get: vi.fn().mockReturnValue({ value: JSON.stringify([{ id: 'http-px', url: 'http://proxy.local:3128' }]) }),
    } as any);

    const job = makeCheckinJob({ config: JSON.stringify({ proxyId: 'http-px' }) });
    await runJob(job, makeAccount());

    const tgProxy = vi.mocked(runCheckin).mock.calls[0][10];
    expect(tgProxy).toBeUndefined();
  });
});

describe('runJob proxy resolution — custom', () => {
  it('passes TgProxy to runCustom when socks5 proxy is configured', async () => {
    vi.mocked(runCustom).mockResolvedValue({ steps: [] } as any);

    vi.mocked(db.prepare).mockReturnValue({
      get: vi.fn().mockReturnValue({ value: JSON.stringify([{ id: 'cp1', url: 'socks5://custom.proxy:1080' }]) }),
    } as any);

    const job = makeCheckinJob({
      jobType: 'custom',
      config: JSON.stringify({ actions: [], proxyId: 'cp1' }),
    });
    await runJob(job, makeAccount());

    const tgProxy = vi.mocked(runCustom).mock.calls[0][6];
    expect(tgProxy).toMatchObject({ ip: 'custom.proxy', port: 1080, socksType: 5 });
  });
});

// ---------------------------------------------------------------------------
// Account-level proxy priority
// ---------------------------------------------------------------------------

const ALL_PROXIES = JSON.stringify([
  { id: 'acct-px', name: 'Account proxy', url: 'socks5://acct.proxy:1080' },
  { id: 'job-px',  name: 'Job proxy',     url: 'socks5://job.proxy:1080' },
  { id: 'tpl-px',  name: 'Template proxy', url: 'socks5://tpl.proxy:1080' },
]);

describe('runJob proxy resolution — account proxy priority (checkin)', () => {
  it('uses account proxy over job config proxy', async () => {
    vi.mocked(runCheckin).mockResolvedValue(stubLog as any);
    vi.mocked(db.prepare).mockReturnValue({ get: vi.fn().mockReturnValue({ value: ALL_PROXIES }) } as any);

    const account = { ...makeAccount(), proxyId: 'acct-px' };
    const job = makeCheckinJob({ config: JSON.stringify({ proxyId: 'job-px' }) });
    await runJob(job, account);

    const tgProxy = vi.mocked(runCheckin).mock.calls[0][10];
    expect(tgProxy).toMatchObject({ ip: 'acct.proxy' });
  });

  it('uses account proxy over template proxy', async () => {
    vi.mocked(runCheckin).mockResolvedValue(stubLog as any);
    vi.mocked(db.prepare).mockImplementation((sql: string) => ({
      get: vi.fn().mockImplementation(() => {
        if (sql.includes('job_templates')) return { config: JSON.stringify({ proxyId: 'tpl-px' }) };
        return { value: ALL_PROXIES };
      }),
    } as any));

    const account = { ...makeAccount(), proxyId: 'acct-px' };
    const job = makeCheckinJob({ templateId: 99, config: null });
    await runJob(job, account);

    const tgProxy = vi.mocked(runCheckin).mock.calls[0][10];
    expect(tgProxy).toMatchObject({ ip: 'acct.proxy' });
  });

  it('falls back to job config proxy when account proxyId is null', async () => {
    vi.mocked(runCheckin).mockResolvedValue(stubLog as any);
    vi.mocked(db.prepare).mockReturnValue({ get: vi.fn().mockReturnValue({ value: ALL_PROXIES }) } as any);

    const job = makeCheckinJob({ config: JSON.stringify({ proxyId: 'job-px' }) });
    await runJob(job, makeAccount()); // proxyId: null

    const tgProxy = vi.mocked(runCheckin).mock.calls[0][10];
    expect(tgProxy).toMatchObject({ ip: 'job.proxy' });
  });

  it('passes no proxy when account proxyId is null and job has no proxy', async () => {
    vi.mocked(runCheckin).mockResolvedValue(stubLog as any);
    vi.mocked(db.prepare).mockReturnValue({ get: vi.fn().mockReturnValue(undefined) } as any);

    await runJob(makeCheckinJob(), makeAccount()); // both null

    const tgProxy = vi.mocked(runCheckin).mock.calls[0][10];
    expect(tgProxy).toBeUndefined();
  });
});

describe('runJob proxy resolution — account proxy priority (custom)', () => {
  it('uses account proxy over job config proxy', async () => {
    vi.mocked(runCustom).mockResolvedValue({ steps: [] } as any);
    vi.mocked(db.prepare).mockReturnValue({ get: vi.fn().mockReturnValue({ value: ALL_PROXIES }) } as any);

    const account = { ...makeAccount(), proxyId: 'acct-px' };
    const job = makeCheckinJob({
      jobType: 'custom',
      config: JSON.stringify({ actions: [], proxyId: 'job-px' }),
    });
    await runJob(job, account);

    const tgProxy = vi.mocked(runCustom).mock.calls[0][6];
    expect(tgProxy).toMatchObject({ ip: 'acct.proxy' });
  });
});

// ---------------------------------------------------------------------------
// ALLOWED_KEYS includes proxies
// ---------------------------------------------------------------------------

vi.mock('../scheduler', () => ({ refreshScheduler: vi.fn() }));

describe('settings ALLOWED_KEYS', () => {
  it('permits the proxies key so proxy lists can be saved', async () => {
    const { ALLOWED_KEYS } = await import('../routes/settings');
    expect(ALLOWED_KEYS).toContain('proxies');
  });
});
