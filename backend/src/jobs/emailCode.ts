import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

// Reads a verification code out of a mailbox, for the `web_email_code` page step: a signup
// form that emails a code is otherwise a dead end mid-run.
//
// Gmail only for now, over IMAP with an app password -- the same route bulkLoginEmail takes.
// The password is never part of the config: the step names a secret (`{gmailAppPassword}`)
// and the value is fetched where this runs.
//
// Both the inbox and the junk folder are read: mail from a domain the account has never
// corresponded with is exactly what Gmail filters, and a signup code is always that.

/** How far back a step looks when it starts, so a code sent a moment earlier still counts. */
export const EMAIL_CODE_LOOKBACK_MS = 120_000;

/** How long to wait for the mail to turn up when the step does not say. */
export const EMAIL_CODE_WAIT_MS = 120_000;

/** How often the mailbox is checked while waiting. */
const POLL_MS = 5_000;

export type EmailCodeQuery = {
  /** The mailbox to read, e.g. me@gmail.com. */
  email: string;
  /** The app password itself, already resolved from the named secret. */
  appPassword: string;
  /** Only consider mail whose sender contains this. Case is ignored. */
  fromContains?: string;
  /** Only consider mail whose subject contains this. Case is ignored. */
  subjectContains?: string;
  /** Expression pulling the code out; capture group 1 wins. Blank looks for a digit run. */
  pattern?: string;
  /** How long to keep looking. */
  waitMs: number;
  /** Ignore anything that arrived before this. */
  sinceMs: number;
};

/**
 * Pulls the code out of a message. With a pattern, group 1 is taken when the expression has
 * one and the whole match otherwise -- the same rule `web_pick` follows. Without one, the
 * first 4-8 digit run wins, preferring one that sits next to the word "code" so a reference
 * number elsewhere in the mail is not mistaken for it.
 */
export function extractCode(
  subject: string,
  body: string,
  pattern?: string,
): string | null {
  const hay = `${subject ?? ""}\n${body ?? ""}`;
  if (pattern?.trim()) {
    let re: RegExp;
    try {
      re = new RegExp(pattern.trim(), "i");
    } catch {
      throw new Error(`\`${pattern.trim()}\` is not a valid expression`);
    }
    const m = hay.match(re);
    if (!m) return null;
    return (m[1] ?? m[0]).trim() || null;
  }
  const labelled = hay.match(/(?:code|otp|pin)\D{0,20}(\d{4,8})/i);
  if (labelled) return labelled[1];
  const any = hay.match(/\b(\d{4,8})\b/);
  return any ? any[1] : null;
}

/** Whether a header line holds the wanted text, ignoring case. Blank matches everything. */
function contains(haystack: string | undefined, needle: string | undefined): boolean {
  const want = needle?.trim().toLowerCase();
  if (!want) return true;
  return (haystack ?? "").toLowerCase().includes(want);
}

/** How a parsed sender reads as one line, for matching and for the log. */
function senderOf(parsed: { from?: { text?: string } | null }): string {
  return parsed.from?.text ?? "";
}

/** Gmail's spam folder when the account is English; the special-use flag is tried first. */
const SPAM_FALLBACK = "[Gmail]/Spam";

/**
 * Where to look, in order. Junk is not optional: a signup code from a domain the mailbox has
 * never seen is exactly the mail Gmail filters, and a step that only reads INBOX then waits
 * out its whole budget against a code sitting in Spam.
 *
 * The folder is found by its special-use flag rather than by name, since Gmail translates
 * the label per account (垃圾邮件, Spam, Correo no deseado). The English path is a fallback
 * for a server that does not advertise the flag.
 */
async function mailboxesToSearch(client: ImapFlow): Promise<string[]> {
  const paths = ["INBOX"];
  try {
    const boxes = await client.list();
    const junk = boxes.find((b) => b.specialUse === "\\Junk");
    if (junk?.path) paths.push(junk.path);
    else if (boxes.some((b) => b.path === SPAM_FALLBACK)) paths.push(SPAM_FALLBACK);
  } catch {
    // A server that will not list is still worth trying the usual path on
    paths.push(SPAM_FALLBACK);
  }
  return paths;
}

/** Reads one mailbox for a matching code. The caller holds the polling loop. */
async function searchMailbox(
  client: ImapFlow,
  path: string,
  since: Date,
  query: EmailCodeQuery,
): Promise<{ code: string; subject: string; from: string } | null> {
  // A folder that has gone missing (or that this account cannot open) is skipped rather
  // than failing the step: the other one may well hold the mail
  let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>>;
  try {
    lock = await client.getMailboxLock(path);
  } catch {
    return null;
  }
  try {
    let uids: number[] = [];
    try {
      await client.noop();
      uids = (await client.search({ since }, { uid: true })) || [];
    } catch {
      return null;
    }
    // Newest first, so a re-sent code wins over the one it replaced
    for (const uid of [...uids].reverse()) {
      const msg = await client.fetchOne(uid, { source: true }, { uid: true });
      if (!msg || !msg.source) continue;
      const parsed = await simpleParser(msg.source);
      const subject = parsed.subject ?? "";
      const from = senderOf(parsed);
      if (!contains(from, query.fromContains)) continue;
      if (!contains(subject, query.subjectContains)) continue;
      const code = extractCode(subject, parsed.text || parsed.html || "", query.pattern);
      if (code) return { code, subject, from };
    }
    return null;
  } finally {
    lock.release();
  }
}

/**
 * Polls the inbox and the junk folder until one of them yields a code, or the wait runs out.
 * Both are read on every pass rather than junk only at the end: which of the two a code
 * lands in is Gmail's call, and it can differ from one run to the next.
 */
export async function fetchGmailCode(
  query: EmailCodeQuery,
): Promise<{ code: string; subject: string; from: string; mailbox: string } | null> {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: query.email, pass: query.appPassword },
    logger: false,
  });
  await client.connect();
  try {
    const paths = await mailboxesToSearch(client);
    const deadline = Date.now() + Math.max(0, query.waitMs);
    const since = new Date(query.sinceMs);
    // Try at least once even on a spent budget: the mail may already be sitting there
    while (true) {
      for (const path of paths) {
        const hit = await searchMailbox(client, path, since, query);
        if (hit) return { ...hit, mailbox: path };
      }
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, Math.min(POLL_MS, deadline - Date.now())));
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}
