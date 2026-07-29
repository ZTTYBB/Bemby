// Live check (scratch): run the saved Levilde template the way the scheduler would,
// resolving its proxy for both Telegram and the browser.
import { db } from './src/db/database';
import { resolveAppClientParams } from './src/tg/appClient';
import { runCustom } from './src/jobs/custom';
import { parseTgProxy } from './src/jobs/runner';
import type { CustomConfig } from './src/types';

const ACC = Number(process.env.ACC ?? 41);
const tpl = db
  .prepare("SELECT config, bot_username FROM job_templates WHERE name = 'Levilde (Mini App checkin)'")
  .get() as { config: string; bot_username: string };

const cfg = JSON.parse(tpl.config) as CustomConfig;
const proxies = JSON.parse(
  (db.prepare("SELECT value FROM settings WHERE key = 'proxies'").get() as any)?.value ?? '[]',
) as Array<{ id: string; name: string; url: string }>;
const proxy = proxies.find((p) => p.id === (cfg as any).proxyId);

const acc = db
  .prepare('SELECT id, name, tg_display_name, api_id, api_hash, session_string, app_client_id FROM tg_accounts WHERE id = ?')
  .get(ACC) as any;

console.log(`account=${acc.name} bot=${tpl.bot_username} proxy=${proxy?.name ?? 'none'}`);
console.log(`config=${tpl.config}\n`);

const log = await runCustom(
  acc.api_id,
  acc.api_hash,
  acc.session_string,
  tpl.bot_username,
  cfg,
  undefined,
  parseTgProxy(proxy?.url),
  resolveAppClientParams(acc.id, acc.app_client_id),
  proxy?.url,
).catch((err: any) => {
  console.log('FAILED:', err?.message, '\n');
  return err?.log;
});

for (const s of log?.steps ?? []) {
  const { responseHtml, responseImage, commandResponseImages, ...rest } = s as any;
  console.log(JSON.stringify(rest));
  if (rest.actionType === 'open_mini_app' && responseHtml)
    console.log('--- app page ---\n' + String(responseHtml).replace(/<br>/g, '\n').slice(0, 600) + '\n');
}
process.exit(0);
