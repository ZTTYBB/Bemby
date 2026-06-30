import type { Job, TgAccount, EmbywatchConfig, EmbywatchLog, TgProxy, TgAppClient, CheckinConfig } from '../types';
import { runCheckin, CheckinError, type CheckinAttemptLog } from './checkin';
import { runEmbywatch } from './embywatch';
import { runCustom, CustomJobError, type CustomJobLog } from './custom';
import { db } from '../db/database';
import type { TgDeviceParams } from '../auth/tgAuth';

function resolveProxyUrl(jobConfig: string | null, templateId: number | null | undefined, accountProxyId?: string | null): string | undefined {
  // Account proxy takes priority over job/template proxy
  let proxyId: string | undefined = accountProxyId ?? undefined;

  if (!proxyId && templateId) {
    try {
      const row = db.prepare('SELECT config FROM job_templates WHERE id = ?').get(templateId) as { config: string | null } | undefined;
      if (row?.config) {
        let c = JSON.parse(row.config);
        if (typeof c === 'string') c = JSON.parse(c);
        proxyId = c?.proxyId;
      }
    } catch { /* ignore */ }
  }
  if (!proxyId && jobConfig) {
    try {
      let c = JSON.parse(jobConfig);
      if (typeof c === 'string') c = JSON.parse(c);
      proxyId = c?.proxyId;
    } catch { /* ignore */ }
  }
  if (!proxyId) return undefined;
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('proxies') as { value: string } | undefined;
    if (!row?.value) return undefined;
    const list = JSON.parse(row.value) as Array<{ id: string; url: string }>;
    return list.find(p => p.id === proxyId)?.url;
  } catch { return undefined; }
}

function resolveAppClientParams(appClientId: string | null | undefined): TgDeviceParams | undefined {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('tg_app_clients') as { value: string } | undefined;
    if (!row?.value) return undefined;
    const list = JSON.parse(row.value) as TgAppClient[];
    const client = appClientId ? list.find(c => c.id === appClientId) : list.find(c => c.isDefault);
    if (!client) return undefined;
    return {
      deviceModel: client.deviceModel,
      systemVersion: client.systemVersion,
      appVersion: client.appVersion,
      langCode: client.langCode,
      langPack: client.langPack,
      systemLangCode: client.systemLangCode,
    };
  } catch { return undefined; }
}

export function parseTgProxy(proxyUrl: string | undefined): TgProxy | undefined {
  if (!proxyUrl) return undefined;
  try {
    const u = new URL(proxyUrl);
    const proto = u.protocol.replace(':', '');
    if (proto !== 'socks5' && proto !== 'socks4' && proto !== 'socks') return undefined;
    return {
      ip: u.hostname,
      port: Number(u.port) || 1080,
      socksType: proto === 'socks4' ? 4 : 5,
      username: u.username || undefined,
      password: u.password || undefined,
    };
  } catch { return undefined; }
}

export type JobDetailLog = CheckinAttemptLog | EmbywatchLog | CustomJobLog;

const RETRY_DELAY_MS = 5_000;

function delayAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Job cancelled')); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Job cancelled')); }, { once: true });
  });
}

export async function runJob(
  job: Job,
  account: TgAccount | null,
  detailLogs?: JobDetailLog[],
  signal?: AbortSignal,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= job.retryMax; attempt++) {
    if (signal?.aborted) throw new Error('Job cancelled');
    try {
      switch (job.jobType) {
        case 'checkin': {
          if (!account) throw new Error('No account linked to this job');
          if (!account.sessionString) throw new Error('Account has no session -- authenticate first');
          const checkinProxyUrl = resolveProxyUrl(job.config, job.templateId, account.proxyId);
          const checkinProxy = parseTgProxy(checkinProxyUrl);
          const checkinDevice = resolveAppClientParams(account.appClientId);
          let checkinCfg: CheckinConfig = {};
          try {
            // For template-linked jobs, use template config as base then overlay job config
            if (job.templateId) {
              const tplRow = db.prepare('SELECT config FROM job_templates WHERE id = ?').get(job.templateId) as { config: string | null } | undefined;
              if (tplRow?.config) {
                let t = JSON.parse(tplRow.config);
                if (typeof t === 'string') t = JSON.parse(t);
                checkinCfg = { ...checkinCfg, ...t };
              }
            }
            if (job.config) {
              let c = JSON.parse(job.config);
              if (typeof c === 'string') c = JSON.parse(c);
              checkinCfg = { ...checkinCfg, ...c };
            }
          } catch { /* ignore */ }
          const log = await runCheckin(
            account.apiId, account.apiHash, account.sessionString,
            job.botUsername, job.replyTimeoutMs, job.startCommand, job.checkinButton, attempt, job.retryMax, signal,
            checkinProxy, checkinDevice, checkinCfg.successContains, checkinCfg.failContains,
          );
          detailLogs?.push(log);
          break;
        }
        case 'embywatch': {
          let jobCfg: Partial<EmbywatchConfig> = JSON.parse(job.config ?? '{}');
          if (typeof jobCfg === 'string') jobCfg = JSON.parse(jobCfg as unknown as string);
          let config: EmbywatchConfig = jobCfg as EmbywatchConfig;
          // Template-linked jobs: merge template config (settings) with job config (credentials)
          if (job.templateId) {
            const tplRow = db.prepare('SELECT config FROM job_templates WHERE id = ?').get(job.templateId) as { config: string | null } | undefined;
            if (tplRow?.config) {
              let tplCfg = JSON.parse(tplRow.config);
              if (typeof tplCfg === 'string') tplCfg = JSON.parse(tplCfg);
              config = { ...tplCfg, ...jobCfg } as EmbywatchConfig;
            }
          }
          if (!config.username || !config.password) throw new Error('Emby username and password are required');
          const log = await runEmbywatch(job.botUsername, config);
          detailLogs?.push(log);
          break;
        }
        case 'custom': {
          if (!account) throw new Error('No account linked to this job');
          if (!account.sessionString) throw new Error('Account has no session -- authenticate first');
          const rawCfg = JSON.parse(job.config ?? '{"actions":[]}');
          const customProxyUrl = resolveProxyUrl(job.config, job.templateId, account.proxyId);
          const customProxy = parseTgProxy(customProxyUrl);
          const customDevice = resolveAppClientParams(account.appClientId);
          const customLog = await runCustom(
            account.apiId, account.apiHash, account.sessionString,
            job.botUsername, rawCfg, signal, customProxy, customDevice,
          );
          detailLogs?.push(customLog);
          break;
        }
        default:
          throw new Error(`Unknown job type: ${job.jobType}`);
      }
      return;
    } catch (err) {
      if (err instanceof CheckinError) detailLogs?.push(err.log);
      if (err instanceof CustomJobError) detailLogs?.push(err.log);
      lastError = err;
      console.error(`[runner] Job "${job.name}" attempt ${attempt}/${job.retryMax} failed:`, err);
      if (attempt < job.retryMax && signal) {
        await delayAbortable(RETRY_DELAY_MS, signal).catch(() => { throw lastError; });
      } else if (attempt < job.retryMax) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  throw lastError;
}
