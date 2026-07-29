// Live check (scratch): @Levildebot -- /start, open the 签到 Mini App button, press
// 立即签到 inside it, and report the page text so the success wording can be pinned down.
import { db } from './src/db/database';
import { resolveAppClientParams } from './src/tg/appClient';
import { runCustom } from './src/jobs/custom';
import type { CustomAction } from './src/types';

const ACC = Number(process.env.ACC ?? 41);
const BOT = process.env.BOT ?? 'Levildebot';
const BTN = process.env.BTN ?? '签到';
const APP_BTNS = (process.env.APP_BTNS ?? '立即签到').split('>').map((s) => s.trim()).filter(Boolean);

const acc = db
  .prepare('SELECT id, name, tg_display_name, api_id, api_hash, session_string, app_client_id FROM tg_accounts WHERE id = ?')
  .get(ACC) as any;

const actions: CustomAction[] = [
  { type: 'send_command', content: '/start' },
  { type: 'wait_reply', maxWaitMs: Number(process.env.WAIT ?? 60_000) },
  {
    type: 'open_mini_app',
    button: BTN,
    appButtons: APP_BTNS,
    ...(process.env.SUCCESS ? { successContains: process.env.SUCCESS } : {}),
  },
];

console.log(`account=${acc.name} (${acc.tg_display_name}) bot=${BOT} button=${BTN} appButtons=${JSON.stringify(APP_BTNS)}`);

const log = await runCustom(
  acc.api_id,
  acc.api_hash,
  acc.session_string,
  BOT,
  { actions },
  undefined,
  undefined,
  resolveAppClientParams(acc.id, acc.app_client_id),
).catch((err: any) => {
  console.log('FAILED:', err?.message, '\n');
  return err?.log;
});

for (const s of log?.steps ?? []) {
  const { responseHtml, responseImage, commandResponseImages, ...rest } = s as any;
  console.log(JSON.stringify(rest));
  if (responseHtml) console.log('--- text ---\n' + String(responseHtml).replace(/<br>/g, '\n').slice(0, 1500) + '\n');
}
process.exit(0);
