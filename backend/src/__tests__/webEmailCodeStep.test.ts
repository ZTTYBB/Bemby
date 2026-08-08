// The `web_email_code` step: what the executor asks the mailbox for, and what it does with
// the answer. The mailbox itself is a stub -- the point here is that the code reaches the
// name and the steps after it, and that the app password stays a reference the whole way
// through rather than a value the browser side ever holds.
//
// The tuning row keeps the between-step pauses out of the run, as the other step tests do.
vi.mock("../db/database", () => ({
  db: {
    prepare: () => ({
      get: () => ({
        value: JSON.stringify({ inAppStepMs: 0, inAppSettleMs: 0, readyPollMs: 100 }),
      }),
      run: () => {},
      all: () => [],
    }),
  },
}));

import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import { runWebSteps } from "../jobs/cloudflare";
import type { WebStep } from "../types";

/** Enough of a page for the steps here: everything is present and typing always lands. */
function fakePage() {
  const typed: Array<{ selector: string; text: string }> = [];
  const page = {
    title: async () => "",
    url: () => "https://signup.example/",
    screenshot: async () => Buffer.from("a jpeg, near enough"),
    keyboard: { press: async () => {}, type: async (text: string) => typed.push({ selector: "", text }) },
    mouse: { move: async () => {}, click: async () => {}, down: async () => {}, up: async () => {} },
    evaluate: async (fn: unknown, arg?: unknown) => {
      const body = String(fn);
      if (typeof arg === "string") {
        if (body.includes("scrollIntoView")) return { x: 20, y: 10 };
        if (body.includes("getBoundingClientRect")) return true;
        return "";
      }
      if (body.includes("challenge-")) return false;
      return "a page with plenty of readable text on it";
    },
    fill: async (selector: string, text: string) => typed.push({ selector, text }),
    type: async (selector: string, text: string) => typed.push({ selector, text }),
  };
  return { page: page as unknown as Page, typed };
}

const run = (page: Page, steps: WebStep[], hooks: Parameters<typeof runWebSteps>[3] = {}) =>
  runWebSteps(page, steps, Date.now() + 30_000, hooks);

const STEP: WebStep = {
  type: "web_email_code",
  email: "me@gmail.com",
  appPassword: "{gmailAppPassword}",
  varName: "code",
  fromContains: "no-reply@signup.example",
  subjectContains: "verification",
  pattern: "code is (\\d{6})",
  waitMs: 5_000,
};

const found = async () => ({
  code: "774411",
  subject: "Your verification code",
  from: "no-reply@signup.example",
});

describe("web_email_code", () => {
  it("holds the code under the name it was given", async () => {
    const f = fakePage();
    const out = await run(f.page, [STEP], { emailCode: found });

    expect(out.ok).toBe(true);
    expect(out.logs[0].outcome).toContain("{code} = 774411");
  });

  it("hands the filters on, and the password as a reference rather than a value", async () => {
    const f = fakePage();
    const seen: any[] = [];
    await run(f.page, [STEP], {
      emailCode: async (q) => {
        seen.push(q);
        return found();
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      email: "me@gmail.com",
      appPasswordRef: "{gmailAppPassword}",
      fromContains: "no-reply@signup.example",
      subjectContains: "verification",
      pattern: "code is (\\d{6})",
    });
  });

  it("lets a later step type the code as {name}", async () => {
    const f = fakePage();
    const out = await run(
      f.page,
      [STEP, { type: "web_input", selector: "#code", text: "{code}" }],
      { emailCode: found },
    );

    expect(out.ok).toBe(true);
    // The field is focused with the pointer and typed on the keyboard, so what matters
    // here is the text that reached it rather than which call carried it
    expect(f.typed.map((t) => t.text)).toContain("774411");
    expect(out.logs[1].outcome).toContain("#code");
  });

  it("fills the mailbox and the filters from the round's own names", async () => {
    const f = fakePage();
    const seen: any[] = [];
    await run(
      f.page,
      [
        { type: "web_set", varName: "inbox", value: "signup@gmail.com" },
        { ...STEP, email: "{inbox}", subjectContains: "" } as WebStep,
      ],
      {
        emailCode: async (q) => {
          seen.push(q);
          return found();
        },
      },
    );

    expect(seen[0].email).toBe("signup@gmail.com");
    expect(seen[0].subjectContains).toBeUndefined();
  });

  it("never waits past the time left for the action", async () => {
    const f = fakePage();
    const seen: any[] = [];
    await runWebSteps(f.page, [{ ...STEP, waitMs: 600_000 } as WebStep], Date.now() + 20_000, {
      emailCode: async (q) => {
        seen.push(q);
        return found();
      },
    });

    expect(seen[0].waitMs).toBeLessThanOrEqual(20_000);
  });

  it("fails, with the mailbox named, when no matching mail arrives", async () => {
    const f = fakePage();
    const out = await run(f.page, [STEP], { emailCode: async () => null });

    expect(out.ok).toBe(false);
    expect(out.failure).toContain("me@gmail.com");
    expect(out.logs[0].error).toMatch(/no matching mail/);
  });

  it("carries the reason up when the mailbox itself refuses", async () => {
    const f = fakePage();
    const out = await run(f.page, [STEP], {
      emailCode: async () => {
        throw new Error("no secret is stored under {gmailAppPassword} (see Settings)");
      },
    });

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toContain("no secret is stored under {gmailAppPassword}");
  });

  it("says so where reading a mailbox is not available", async () => {
    const f = fakePage();
    const out = await run(f.page, [STEP], {});

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toMatch(/not available here/);
  });

  it("refuses a step with no name to hold the code under", async () => {
    const f = fakePage();
    const out = await run(f.page, [{ ...STEP, varName: "" } as WebStep], { emailCode: found });

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toMatch(/no name given/);
  });

  it("refuses a password typed in rather than a secret's name", async () => {
    const f = fakePage();
    const out = await run(f.page, [{ ...STEP, appPassword: "abcd efgh ijkl" } as WebStep], {
      emailCode: found,
    });

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toMatch(/must name a secret/);
  });

  it("refuses a step with no app-password secret named", async () => {
    const f = fakePage();
    const out = await run(f.page, [{ ...STEP, appPassword: "" } as WebStep], {
      emailCode: found,
    });

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toMatch(/no app-password secret/);
  });
});
