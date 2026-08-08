// Pulling the code out of a message: the part of the `web_email_code` step that runs on
// whatever the mailbox hands back, and so the part worth covering without an inbox.
//
// The mailbox traversal is covered too, against a stand-in IMAP server: which folders are
// opened, and in what order, is what decides whether a spam-filtered code is ever found.

const { imap } = vi.hoisted(() => ({
  imap: {
    /** Messages per folder path, as the JSON the stubbed parser hands back. */
    folders: {} as Record<string, Array<{ subject: string; text: string; from: string }>>,
    /** What `list()` advertises; a throw stands for a server that will not list. */
    listed: [] as Array<{ path: string; specialUse?: string }>,
    listThrows: false,
    /** Every folder the run opened, in order. */
    opened: [] as string[],
    open: "",
  },
}));

vi.mock("imapflow", () => ({
  ImapFlow: class {
    async connect() {}
    async logout() {}
    async noop() {}
    async list() {
      if (imap.listThrows) throw new Error("LIST refused");
      return imap.listed;
    }
    async getMailboxLock(path: string) {
      if (!(path in imap.folders)) throw new Error(`no mailbox ${path}`);
      imap.opened.push(path);
      imap.open = path;
      return { release: () => {} };
    }
    async search() {
      return imap.folders[imap.open].map((_, i) => i + 1);
    }
    async fetchOne(uid: number) {
      return { source: Buffer.from(JSON.stringify(imap.folders[imap.open][uid - 1])) };
    }
  },
}));

vi.mock("mailparser", () => ({
  simpleParser: async (source: Buffer) => {
    const m = JSON.parse(String(source));
    return { subject: m.subject, text: m.text, from: { text: m.from } };
  },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractCode, fetchGmailCode } from "../jobs/emailCode";

describe("extractCode", () => {
  it("prefers a digit run next to the word code", () => {
    const body = "Order 4471 is on its way.\nYour code is 908213. It expires in 10 minutes.";
    expect(extractCode("Confirm your address", body)).toBe("908213");
  });

  it("takes the first digit run when nothing is labelled", () => {
    expect(extractCode("", "Use 4827 to finish signing up")).toBe("4827");
  });

  it("reads a code out of the subject", () => {
    expect(extractCode("112233 is your verification code", "")).toBe("112233");
  });

  it("ignores runs that are too long to be a code", () => {
    expect(extractCode("", "Reference 1234567890123 was logged")).toBeNull();
  });

  it("returns null when there is nothing to take", () => {
    expect(extractCode("Welcome", "Thanks for joining us.")).toBeNull();
  });

  it("keeps capture group 1 of a pattern", () => {
    expect(extractCode("", "Sign-in token: AB-9931", "token: ([A-Z]{2}-\\d{4})")).toBe(
      "AB-9931",
    );
  });

  it("keeps the whole match when the pattern has no group", () => {
    expect(extractCode("", "code ZZ8842 valid", "[A-Z]{2}\\d{4}")).toBe("ZZ8842");
  });

  it("matches a pattern regardless of case", () => {
    expect(extractCode("", "Your CODE is 5150", "your code is (\\d+)")).toBe("5150");
  });

  it("returns null when the pattern matches nothing", () => {
    expect(extractCode("", "no code here", "token: (\\d+)")).toBeNull();
  });

  it("says so when the pattern will not compile", () => {
    expect(() => extractCode("", "anything", "(unclosed")).toThrow(/not a valid expression/);
  });
});


const SPAM = "[Gmail]/Spam";

const mail = (subject: string, text: string, from = "no-reply@signup.example") => ({
  subject,
  text,
  from,
});

const query = {
  email: "me@gmail.com",
  appPassword: "abcd efgh",
  waitMs: 0,
  sinceMs: Date.now() - 60_000,
};

beforeEach(() => {
  imap.folders = {};
  imap.listed = [];
  imap.listThrows = false;
  imap.opened = [];
  imap.open = "";
});

describe("fetchGmailCode", () => {
  it("finds a code the provider filed as spam", async () => {
    imap.listed = [{ path: "INBOX" }, { path: SPAM, specialUse: "\\Junk" }];
    imap.folders = { INBOX: [], [SPAM]: [mail("Verify", "Your code is 445566")] };

    const found = await fetchGmailCode(query);

    expect(found?.code).toBe("445566");
    expect(found?.mailbox).toBe(SPAM);
  });

  it("finds the junk folder by its flag, whatever the account calls it", async () => {
    const localised = "[Gmail]/垃圾邮件";
    imap.listed = [{ path: "INBOX" }, { path: localised, specialUse: "\\Junk" }];
    imap.folders = { INBOX: [], [localised]: [mail("Verify", "code 778899")] };

    const found = await fetchGmailCode(query);

    expect(found?.mailbox).toBe(localised);
    expect(imap.opened).toEqual(["INBOX", localised]);
  });

  it("reads the inbox first, and stops there when the code is in it", async () => {
    imap.listed = [{ path: "INBOX" }, { path: SPAM, specialUse: "\\Junk" }];
    imap.folders = {
      INBOX: [mail("Verify", "code 111222")],
      [SPAM]: [mail("Verify", "code 999888")],
    };

    const found = await fetchGmailCode(query);

    expect(found?.code).toBe("111222");
    expect(found?.mailbox).toBe("INBOX");
    expect(imap.opened).toEqual(["INBOX"]);
  });

  it("falls back to the usual spam path when no folder advertises the flag", async () => {
    imap.listed = [{ path: "INBOX" }, { path: SPAM }];
    imap.folders = { INBOX: [], [SPAM]: [mail("Verify", "code 313131")] };

    expect((await fetchGmailCode(query))?.mailbox).toBe(SPAM);
  });

  it("still tries the usual spam path when the server will not list", async () => {
    imap.listThrows = true;
    imap.folders = { INBOX: [], [SPAM]: [mail("Verify", "code 424242")] };

    expect((await fetchGmailCode(query))?.mailbox).toBe(SPAM);
  });

  it("carries on when a folder cannot be opened at all", async () => {
    imap.listed = [{ path: "INBOX" }, { path: SPAM, specialUse: "\\Junk" }];
    // Only the inbox exists on the stand-in, so opening spam throws
    imap.folders = { INBOX: [mail("Verify", "code 505050")] };

    expect((await fetchGmailCode(query))?.code).toBe("505050");
  });

  it("applies the sender and subject filters in the junk folder too", async () => {
    imap.listed = [{ path: "INBOX" }, { path: SPAM, specialUse: "\\Junk" }];
    imap.folders = {
      INBOX: [],
      [SPAM]: [
        mail("Weekly digest", "code 121212", "news@elsewhere.example"),
        mail("Verify your address", "code 343434"),
      ],
    };

    const found = await fetchGmailCode({
      ...query,
      fromContains: "signup.example",
      subjectContains: "verify",
    });

    expect(found?.code).toBe("343434");
  });

  it("returns null when neither folder holds anything matching", async () => {
    imap.listed = [{ path: "INBOX" }, { path: SPAM, specialUse: "\\Junk" }];
    imap.folders = { INBOX: [], [SPAM]: [mail("Newsletter", "nothing to take here")] };

    expect(await fetchGmailCode(query)).toBeNull();
    expect(imap.opened).toEqual(["INBOX", SPAM]);
  });
});
