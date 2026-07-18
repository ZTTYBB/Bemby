import Database from 'better-sqlite3';
import { runCustom } from './src/jobs/custom';
const db = new Database('data/bemby.db', { readonly: true });
const a = db.prepare('SELECT api_id, api_hash, session_string FROM tg_accounts WHERE id = 4').get() as any;
const tpl = db.prepare('SELECT config FROM job_templates WHERE id = 27').get() as any;
const config = JSON.parse(tpl.config);
console.log('actions:', config.actions.map((x:any)=>x.type+(x.button?`(${x.button}${x.cfChallenge?',cf':''})`:'')).join(' -> '));
const done = (log:any)=>{ for (const s of log.steps) console.log(`STEP ${s.step} [${s.actionType}] clicked=${s.clickedButton??'-'} result=${s.result??'-'} error=${s.error??'-'} cfHost=${s.cfHost??'-'} cfChallenged=${s.cfChallenged} cfPassed=${s.cfPassed}`); };
try { const log = await runCustom(a.api_id,a.api_hash,a.session_string,'lotayu_bot',config,undefined,undefined,undefined,undefined); console.log('=== OK ==='); done(log); }
catch(e:any){ console.log('=== THREW:', e?.message,'==='); if(e?.log) done(e.log); }
process.exit(0);
