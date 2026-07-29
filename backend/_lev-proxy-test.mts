// Live check (scratch): open @Levildebot's 签到 Mini App through each configured proxy
// in turn, to find one whose IP Cloudflare accepts. The Telegram side stays direct;
// only the browser is proxied, which is what loadCheckinUrl's proxy argument does.
import { TelegramClient, Api, Logger } from 'telegram';
import { LogLevel } from 'telegram/extensions/Logger';
import { StringSession } from 'telegram/sessions';
import { db } from './src/db/database';
import { resolveAppClientParams } from './src/tg/appClient';
import { openableButtonUrl, webButtonOf } from './src/tg/miniApp';
import { loadCheckinUrl } from './src/jobs/cloudflare';

const ACC = Number(process.env.ACC ?? 41);
const BOT = process.env.BOT ?? 'Levildebot';
const BTN = process.env.BTN ?? '签到';
const APP_BTNS = (process.env.APP_BTNS ?? '立即签到').split('>').map((s) => s.trim()).filter(Boolean);
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a: unknown[]) => console.log(ts(), ...a);

const acc = db
  .prepare('SELECT id, api_id, api_hash, session_string, app_client_id FROM tg_accounts WHERE id = ?')
  .get(ACC) as any;

type Proxy = { id: string; name: string; url: string };
const proxies: Proxy[] = JSON.parse(
  (db.prepare("SELECT value FROM settings WHERE key = 'proxies'").get() as any)?.value ?? '[]',
);
// undefined = the host's own IP, for comparison
const candidates: (Proxy | undefined)[] = [undefined, ...proxies];

const client = new TelegramClient(new StringSession(acc.session_string), acc.api_id, acc.api_hash, {
  connectionRetries: 3,
  autoReconnect: false,
  baseLogger: new Logger(LogLevel.NONE),
  ...(resolveAppClientParams(acc.id, acc.app_client_id) ?? {}),
});
await client.connect();

// A fresh signed URL per attempt: the init data is short-lived
const freshUrl = async (): Promise<string | undefined> => {
  await client.sendMessage(BOT, { message: '/start' });
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const msgs = (await client.getMessages(BOT, { limit: 3 })) as Api.Message[];
    for (const m of msgs) {
      const markup = (m as any).replyMarkup;
      if (!(markup instanceof Api.ReplyInlineMarkup)) continue;
      for (const row of markup.rows)
        for (const btn of row.buttons) {
          const web = webButtonOf(btn);
          if (web?.miniApp && web.text.includes(BTN)) {
            const { url, signed } = await openableButtonUrl(client, web, BOT, m);
            if (signed) return url;
          }
        }
    }
  }
  return undefined;
};

for (const proxy of candidates) {
  const label = proxy ? `${proxy.name} (${proxy.url.replace(/\/\/[^@]*@/, '//***@')})` : 'no proxy (host IP)';
  log(`=== ${label} ===`);
  const url = await freshUrl();
  if (!url) { log('  could not obtain a signed mini app URL'); continue; }

  const res = await loadCheckinUrl(url, proxy?.url, { miniApp: true, inAppClicks: APP_BTNS });
  log(`  ok=${res.ok} challenged=${res.challenged} host=${res.finalHost} inApp=${JSON.stringify(res.inAppAction)}`);
  log('  text: ' + res.text.replace(/\n+/g, ' | ').slice(0, 300));
  if (res.ok && !/失败|failed/i.test(res.text)) { log('  PASSED with', label); break; }
}

await client.destroy().catch(() => {});
process.exit(0);
