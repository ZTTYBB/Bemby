// Branching on what the page shows. The case that matters is a login: the browser keeps its
// cookies between runs, so a job must be able to ask "does this site still know me?" and only
// fill the form in when the answer is no -- a site that rations logins will not give out
// another one just because the job did not think to look.
//
// The tuning row keeps the between-step pauses and the poll interval small: they are there for
// a real page to settle and are dead time against a stand-in.
vi.mock("../db/database", () => ({
  db: {
    prepare: () => ({
      get: () => ({
        value: JSON.stringify({ inAppStepMs: 0, inAppSettleMs: 0, readyPollMs: 50 }),
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

const HOME = "https://forum.example/";

/**
 * A page that answers what a condition asks of a browser. `holds` maps a selector to whether
 * the page has it -- a function instead of a list makes the answer depend on when it is asked,
 * for something the page draws a moment after loading. `text` is the page's own words, which
 * both a text condition and the page-ready wait read.
 */
function fakePage(opts: { holds?: Record<string, boolean | (() => boolean)>; text?: string } = {}) {
  const visited: string[] = [HOME];
  const holds = opts.holds ?? {};
  const body = opts.text ?? "a page with plenty of readable text on it, rather than one booting";

  const page = {
    title: async () => "",
    url: () => visited[visited.length - 1],
    goto: async (url: string) => {
      visited.push(url);
    },
    goBack: async () => {
      if (visited.length > 1) visited.pop();
    },
    screenshot: async () => {
      throw new Error("the stand-in page takes no screenshots");
    },
    evaluate: async (fn: unknown, arg?: unknown) => {
      // An element condition passes its selector on its own
      if (typeof arg === "string") {
        const held = holds[arg];
        return typeof held === "function" ? held() : (held ?? false);
      }
      // `isInterstitial` looks for the challenge markers; nothing here is a challenge page
      if (String(fn).includes("challenge-")) return false;
      return body;
    },
  };

  return { page: page as unknown as Page, visited };
}

const run = (page: Page, steps: WebStep[]) => runWebSteps(page, steps, Date.now() + 30_000, {});

/** Steps that get through without needing anything of the page, to mark which branch ran. */
const THEN_STEP: WebStep = { type: "web_goto", url: `${HOME}then` };
const ELSE_STEP: WebStep = { type: "web_goto", url: `${HOME}else` };

/** Which branch ran, read off where the browser ended up. */
const wentTo = (visited: string[]) => visited.at(-1)?.replace(HOME, "") ?? "";

describe("web_if on an element", () => {
  it("runs the then steps when the element is there", async () => {
    const f = fakePage({ holds: { "#login-form": true } });
    const out = await run(f.page, [
      {
        type: "web_if",
        check: "element",
        selector: "#login-form",
        then: [THEN_STEP],
        otherwise: [ELSE_STEP],
      },
    ]);

    expect(out.ok).toBe(true);
    expect(wentTo(f.visited)).toBe("then");
    expect(out.logs[0].outcome).toBe("`#login-form` is there, running the 1 then step(s)");
    // The condition is a container: what it runs carries the screenshots, not it
    expect(out.logs[0].screenshot).toBeUndefined();
  });

  it("runs the else steps when it is not", async () => {
    const f = fakePage({ holds: {} });
    const out = await run(f.page, [
      {
        type: "web_if",
        check: "element",
        selector: "#login-form",
        waitMs: 100,
        then: [THEN_STEP],
        otherwise: [ELSE_STEP],
      },
    ]);

    expect(out.ok).toBe(true);
    expect(wentTo(f.visited)).toBe("else");
    expect(out.logs[0].outcome).toContain("is not there, running the 1 else step(s)");
  });

  it("turns the test round when told to, for \"if not logged in\"", async () => {
    const f = fakePage({ holds: { ".avatar": true } });
    const out = await run(f.page, [
      {
        type: "web_if",
        check: "element",
        selector: ".avatar",
        negate: true,
        then: [THEN_STEP],
        otherwise: [ELSE_STEP],
      },
    ]);

    // The avatar is there, so "if not logged in" must not take the login branch
    expect(wentTo(f.visited)).toBe("else");
  });

  it("does not count an element with no box on screen, which a hidden form has", async () => {
    // The page holds the node but it measures nothing -- the same test `web_wait_element` uses
    const f = fakePage({ holds: { "#login-form": false } });
    const out = await run(f.page, [
      {
        type: "web_if",
        check: "element",
        selector: "#login-form",
        waitMs: 100,
        then: [THEN_STEP],
        otherwise: [ELSE_STEP],
      },
    ]);
    expect(wentTo(f.visited)).toBe("else");
  });

  it("waits for something the page has yet to draw, rather than branching too early", async () => {
    let asked = 0;
    const f = fakePage({ holds: { ".avatar": () => ++asked > 2 } });
    const out = await run(f.page, [
      {
        type: "web_if",
        check: "element",
        selector: ".avatar",
        waitMs: 2000,
        then: [THEN_STEP],
        otherwise: [ELSE_STEP],
      },
    ]);

    // Asking once would have called the session dead and spent a login the site rations
    expect(wentTo(f.visited)).toBe("then");
    expect(asked).toBeGreaterThan(2);
    expect(out.ok).toBe(true);
  });

  it("gives up once its wait is spent", async () => {
    const f = fakePage({ holds: { ".avatar": false } });
    const started = Date.now();
    const out = await run(f.page, [
      {
        type: "web_if",
        check: "element",
        selector: ".avatar",
        waitMs: 300,
        then: [THEN_STEP],
        otherwise: [ELSE_STEP],
      },
    ]);
    expect(wentTo(f.visited)).toBe("else");
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(out.ok).toBe(true);
  });
});

describe("web_if on the page text and the address", () => {
  it("looks for words on the page, ignoring case", async () => {
    const f = fakePage({ text: "Welcome back, someuser -- you have 3 new replies" });
    const out = await run(f.page, [
      { type: "web_if", check: "text", text: "welcome back", then: [THEN_STEP], otherwise: [ELSE_STEP] },
    ]);
    expect(wentTo(f.visited)).toBe("then");
    expect(out.logs[0].outcome).toContain('"welcome back" in the page text is there');
  });

  it("takes the else branch when the words are absent", async () => {
    const f = fakePage({ text: "Sign in to continue" });
    const out = await run(f.page, [
      {
        type: "web_if",
        check: "text",
        text: "welcome back",
        waitMs: 100,
        then: [THEN_STEP],
        otherwise: [ELSE_STEP],
      },
    ]);
    expect(wentTo(f.visited)).toBe("else");
  });

  it("looks at the address the browser is on", async () => {
    const f = fakePage();
    const out = await run(f.page, [
      { type: "web_goto", url: `${HOME}login` },
      { type: "web_if", check: "url", text: "login", then: [THEN_STEP], otherwise: [ELSE_STEP] },
    ]);
    // A site that bounces a signed-out visitor to its login page is the case for this
    expect(wentTo(f.visited)).toBe("then");
  });
});

describe("web_if branches", () => {
  it("carries on with what follows when the branch it took is empty", async () => {
    const f = fakePage({ holds: {} });
    const out = await run(f.page, [
      { type: "web_if", check: "element", selector: "#login-form", waitMs: 50, then: [THEN_STEP] },
      { type: "web_goto", url: `${HOME}after` },
    ]);

    expect(out.ok).toBe(true);
    expect(out.logs[0].outcome).toContain("there are no else steps to run");
    expect(wentTo(f.visited)).toBe("after");
  });

  it("fails when a step inside the branch fails", async () => {
    const f = fakePage({ holds: { "#login-form": true } });
    const out = await run(f.page, [
      {
        type: "web_if",
        check: "element",
        selector: "#login-form",
        then: [{ type: "web_goto", url: "not-an-address" }],
      },
    ]);

    expect(out.ok).toBe(false);
    expect(out.logs[1].error).toMatch(/must start with http/);
    expect(out.failure).toMatch(/must start with http/);
  });

  it("fails a condition with nothing to look for", async () => {
    const f = fakePage();
    const out = await run(f.page, [
      { type: "web_if", check: "element", selector: "  ", then: [THEN_STEP] },
    ]);
    expect(out.logs[0].error).toBe("no CSS selector given to look for");

    const g = fakePage();
    const words = await run(g.page, [{ type: "web_if", check: "text", then: [THEN_STEP] }]);
    expect(words.logs[0].error).toBe("no words given to look for");
  });

  it("allows a loop inside a branch, which is where the task itself goes", async () => {
    const f = fakePage({ holds: { ".avatar": true } });
    const out = await run(f.page, [
      {
        type: "web_if",
        check: "element",
        selector: ".avatar",
        then: [{ type: "web_repeat", times: 2, steps: [{ type: "web_delay", waitMs: 1 }] }],
      },
    ]);

    expect(out.ok).toBe(true);
    expect(out.logs.find((l) => l.type === "web_repeat")!.outcome).toBe(
      "2 of 2 round(s) got through",
    );
  });

  it("still refuses a loop inside a loop, however it was reached", async () => {
    const f = fakePage({ holds: { ".avatar": true } });
    const out = await run(f.page, [
      {
        type: "web_repeat",
        times: 1,
        steps: [
          {
            type: "web_if",
            check: "element",
            selector: ".avatar",
            then: [{ type: "web_repeat", times: 2, steps: [{ type: "web_delay", waitMs: 1 }] }],
          },
        ],
      },
    ]);

    expect(out.ok).toBe(false);
    expect(out.failure).toMatch(/cannot be put inside another loop/);
  });

  it("refuses conditions nested past the limit", async () => {
    const deep = (n: number): WebStep =>
      n === 0
        ? THEN_STEP
        : {
            type: "web_if",
            check: "element",
            selector: ".avatar",
            then: [deep(n - 1)],
          };
    const f = fakePage({ holds: { ".avatar": true } });
    const out = await run(f.page, [deep(5)]);
    expect(out.ok).toBe(false);
    expect(out.failure).toMatch(/cannot be nested more than 3 deep/);
  });
});

describe("the login shape it exists for", () => {
  // The template's opening move: land on the front page, and only log in if the cookie the
  // last run left behind has stopped working.
  // The form is filled in by steps the real template carries; here the trip to the login page
  // stands for the whole thing, since what is being tested is whether that trip happens.
  const loginIfNeeded = (task: WebStep[]): WebStep[] => [
    { type: "web_goto", url: HOME },
    {
      type: "web_if",
      check: "element",
      selector: 'a[href="/login"]',
      waitMs: 200,
      then: [
        { type: "web_goto", url: `${HOME}login` },
        { type: "web_delay", waitMs: 1 },
        { type: "web_goto", url: HOME },
      ],
    },
    ...task,
  ];

  it("logs in when the site no longer knows the browser", async () => {
    const f = fakePage({ holds: { 'a[href="/login"]': true } });
    const out = await run(f.page, loginIfNeeded([{ type: "web_goto", url: `${HOME}task` }]));

    expect(out.ok).toBe(true);
    expect(f.visited).toEqual([HOME, HOME, `${HOME}login`, HOME, `${HOME}task`]);
  });

  it("skips the login form when the cookie still works", async () => {
    const f = fakePage({ holds: {} });
    const out = await run(f.page, loginIfNeeded([{ type: "web_goto", url: `${HOME}task` }]));

    // No trip to the login page at all: the site rations them, and this run did not need one
    expect(out.ok).toBe(true);
    expect(f.visited).toEqual([HOME, HOME, `${HOME}task`]);
    expect(f.visited.some((u) => u.includes("login"))).toBe(false);
  });
});
