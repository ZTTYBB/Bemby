// The loop's own bookkeeping -- how many rounds run, what each round picks, which values get
// remembered, what a failed round costs the ones after it -- and the navigation and reading
// steps, against a stand-in page rather than a real browser. The real-browser cover in
// webStepsBrowser.test.ts skips itself when CloakBrowser is not installed, which is exactly
// when this control flow would otherwise go untested.
//
// The shape being tested is a person working a forum: go to the front page, pick a post not
// yet replied to, read it, reply, come back, and do it again -- against a page whose contents
// move between rounds.
//
// The tuning row keeps the between-step pauses out of the run: they are there for a real page
// to settle and are dead time against a stand-in.
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

const HOME = "https://forum.example/";

/**
 * A page that answers the handful of things these steps ask of a browser. `evaluate` has to
 * tell its callers apart, which it does by what they hand it: the pick step passes an argument
 * object, the read step passes a bare selector, and the rest are told apart by what their
 * body asks for.
 *
 * `matches` maps a selector to what the page holds for it. Passing a function instead of a
 * list makes the answer depend on when it is asked -- a front page that moves between rounds.
 */
function fakePage(matches: Record<string, string[] | (() => string[])> = {}) {
  const visited: string[] = [HOME];
  let gotoError: string | undefined;

  const held = (sel: string): string[] => {
    const found = matches[sel];
    return typeof found === "function" ? found() : (found ?? []);
  };

  const page = {
    title: async () => "",
    url: () => visited[visited.length - 1],
    goto: async (url: string) => {
      if (gotoError) throw new Error(gotoError);
      visited.push(url);
    },
    goBack: async () => {
      if (visited.length < 2) return;
      visited.pop();
    },
    screenshot: async () => {
      throw new Error("the stand-in page takes no screenshots");
    },
    evaluate: async (fn: unknown, arg?: unknown) => {
      // The pick step is the only call that hands the page an argument object
      if (arg && typeof arg === "object" && "sel" in (arg as Record<string, unknown>))
        return held((arg as { sel: string }).sel);
      // The read step passes its selector on its own
      if (typeof arg === "string") return held(arg)[0] ?? "";
      // `isInterstitial` looks for the challenge markers; nothing here is a challenge page
      if (String(fn).includes("challenge-")) return false;
      // Anything else reading the page gets text long enough to count as rendered
      return "a page with plenty of readable text on it, rather than one still booting up";
    },
  };

  return {
    page: page as unknown as Page,
    visited,
    /** Makes the next navigation fail, as a page that never loads does. */
    failNavigation: (message: string) => {
      gotoError = message;
    },
  };
}

const run = (page: Page, steps: WebStep[], hooks: Parameters<typeof runWebSteps>[3] = {}) =>
  runWebSteps(page, steps, Date.now() + 30_000, hooks);

const POSTS = ".post-list-item a";
const PICK: WebStep = {
  type: "web_pick",
  selector: POSTS,
  varName: "postId",
  attribute: "href",
  pattern: "/post-(\\d+)",
  skipUsed: true,
};

/** The front page, holding three posts. */
const LIST = { [POSTS]: ["/post-859148-1", "/post-859149-1", "/post-859150-1"] };

/** A step that always gets through, without touching the page. */
const OK_STEP: WebStep = { type: "web_delay", waitMs: 1 };

const repeat = (times: number, steps: WebStep[], extra: Record<string, unknown> = {}): WebStep =>
  ({ type: "web_repeat", times, steps, ...extra }) as WebStep;

describe("web_repeat", () => {
  it("runs the number of rounds it was given, with no list to iterate over", async () => {
    const f = fakePage();
    const out = await run(f.page, [repeat(3, [OK_STEP])]);

    expect(out.ok).toBe(true);
    expect(out.logs.filter((l) => l.type === "web_delay").map((l) => l.iteration)).toEqual([
      "1/3",
      "2/3",
      "3/3",
    ]);
    const summary = out.logs.find((l) => l.type === "web_repeat")!;
    expect(summary.outcome).toBe("3 of 3 round(s) got through");
    // The loop is a container: its rounds carry the screenshots, not it
    expect(summary.screenshot).toBeUndefined();
  });

  it("fails a loop with no count, rather than quietly running nothing", async () => {
    const f = fakePage();
    const out = await run(f.page, [repeat(0, [OK_STEP])]);
    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toBe("no number of rounds given");
  });

  it("fails a loop with nothing in it", async () => {
    const f = fakePage();
    const out = await run(f.page, [repeat(2, [])]);
    expect(out.logs[0].error).toBe("the loop has no steps to run");
  });

  it("refuses a loop inside a loop", async () => {
    const f = fakePage();
    const out = await run(f.page, [repeat(2, [repeat(2, [OK_STEP])])]);
    expect(out.ok).toBe(false);
    expect(out.failure).toMatch(/cannot be put inside another loop/);
  });

  it("waits between rounds, but not on its way out of the last one", async () => {
    const f = fakePage();
    const started = Date.now();
    const out = await run(f.page, [repeat(3, [OK_STEP], { betweenMs: 60 })]);
    expect(out.ok).toBe(true);
    // Two gaps for three rounds; a third would mean the loop paused before finishing
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(110);
    expect(waited).toBeLessThan(240);
  });
});

describe("web_pick inside a round", () => {
  it("goes to the front page each round and picks a post not yet replied to", async () => {
    const f = fakePage(LIST);
    const used: string[] = [];
    const out = await run(
      f.page,
      [
        repeat(3, [
          { type: "web_goto", url: HOME },
          PICK,
          { type: "web_goto", url: `${HOME}post-{postId}-1` },
        ]),
      ],
      { usedValues: () => used.slice(), markUsed: (_name, value) => used.push(value) },
    );

    expect(out.ok).toBe(true);
    // Home, then the post, three times over -- a person's path through a forum
    expect(f.visited.slice(1)).toEqual([
      HOME,
      `${HOME}post-859148-1`,
      HOME,
      `${HOME}post-859149-1`,
      HOME,
      `${HOME}post-859150-1`,
    ]);
    expect(used).toEqual(["859148", "859149", "859150"]);
  });

  it("does not pick the same post twice in one run, before anything is remembered", async () => {
    // Nothing reaches the store until a round finishes, so the within-run bookkeeping is the
    // only thing stopping round 2 from landing on round 1's post
    const f = fakePage(LIST);
    const out = await run(f.page, [repeat(3, [PICK])], { usedValues: () => [] });

    const picks = out.logs.filter((l) => l.type === "web_pick").map((l) => l.outcome);
    expect(picks).toHaveLength(3);
    expect(new Set(picks).size).toBe(3);
  });

  it("leaves out posts replied to on an earlier run", async () => {
    const f = fakePage(LIST);
    const out = await run(f.page, [repeat(1, [PICK])], {
      usedValues: () => ["859148", "859149"],
    });
    expect(out.logs[1].outcome).toContain("picked 859150");
    expect(out.logs[1].outcome).toContain("2 of 3 already used");
  });

  it("sharpens the round label with what it picked, so later steps say which post", async () => {
    const f = fakePage(LIST);
    const out = await run(f.page, [repeat(2, [PICK, OK_STEP])], { usedValues: () => [] });

    // The pick itself is logged before it knows the value; everything after it carries it
    expect(out.logs.filter((l) => l.type === "web_delay").map((l) => l.iteration)).toEqual([
      "1/2 859148",
      "2/2 859149",
    ]);
  });

  it("picks from the page as it stands each round, not a copy taken at the start", async () => {
    // The point of picking inside the loop: the front page moves while the job is on it
    let round = 0;
    const f = fakePage({
      [POSTS]: () => (round++ === 0 ? ["/post-1-1"] : ["/post-2-1", "/post-1-1"]),
    });
    const out = await run(f.page, [repeat(2, [PICK])], { usedValues: () => [] });

    expect(out.ok).toBe(true);
    const picks = out.logs.filter((l) => l.type === "web_pick");
    expect(picks[0].outcome).toContain("picked 1 for");
    // Round 2 sees a post that did not exist when round 1 ran, and takes it
    expect(picks[1].outcome).toContain("picked 2 for");
  });

  it("stops the loop quietly once the page holds nothing new", async () => {
    const f = fakePage({ [POSTS]: ["/post-859148-1"] });
    const used: string[] = [];
    const out = await run(f.page, [repeat(3, [PICK, OK_STEP])], {
      usedValues: () => used.slice(),
      markUsed: (_name, value) => used.push(value),
    });

    // One post, three rounds asked for: the first replies, the second finds nothing left. A
    // job that has already replied to everything on the front page is not a failed job.
    expect(out.ok).toBe(true);
    expect(used).toEqual(["859148"]);
    expect(out.logs.find((l) => l.type === "web_repeat")!.outcome).toBe(
      "1 of 3 round(s) got through; nothing left to pick",
    );
  });

  it("skips the rest of the round when there was nothing to pick", async () => {
    const f = fakePage({ [POSTS]: ["/post-859148-1"] });
    const out = await run(
      f.page,
      [repeat(2, [PICK, { type: "web_goto", url: `${HOME}p-{postId}` }])],
      { usedValues: () => ["859148"] },
    );

    // Without this the round would carry on and open a literal `{postId}` address
    expect(out.ok).toBe(true);
    expect(f.visited).toEqual([HOME]);
    expect(out.logs.some((l) => l.type === "web_goto")).toBe(false);
  });

  it("fails the round when the list itself is not on the page", async () => {
    const f = fakePage({});
    const out = await run(f.page, [repeat(1, [PICK])], { usedValues: () => [] });
    expect(out.ok).toBe(false);
    expect(out.logs[1].error).toMatch(/nothing matching `.post-list-item a` is on the page/);
  });

  it("spreads the choice about when asked to pick at random", async () => {
    // A person does not always reply to whatever sits at the top, and neither should this
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 40; attempt++) {
      const f = fakePage(LIST);
      const out = await run(f.page, [repeat(1, [{ ...PICK, choose: "random" } as WebStep])], {
        usedValues: () => [],
      });
      const outcome = out.logs[1].outcome ?? "";
      seen.add(outcome.split("picked ")[1]?.split(" ")[0] ?? "");
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("rounds that fail", () => {
  /** Finding the reply form, which only some posts have -- a round falling over part way. */
  const REPLY_FORM: WebStep = { type: "web_pick", selector: "#form-{postId}", varName: "form" };
  const withForms = (...ids: string[]) => {
    const forms: Record<string, string[]> = { ...LIST };
    for (const id of ids) forms[`#form-${id}`] = ["ok"];
    return fakePage(forms);
  };

  it("carries on with the next round, and does not remember the post that failed", async () => {
    const f = withForms("859148", "859150");
    const used: string[] = [];
    const out = await run(f.page, [repeat(3, [PICK, REPLY_FORM])], {
      usedValues: () => used.slice(),
      markUsed: (_name, value) => used.push(value),
    });

    // One post short is not the action failing -- the other two still got their reply
    expect(out.ok).toBe(true);
    expect(used).toEqual(["859148", "859150"]);
    const summary = out.logs.find((l) => l.type === "web_repeat")!;
    expect(summary.error).toBeUndefined();
    expect(summary.outcome).toContain("2 of 3");
    expect(summary.outcome).toContain("1 failed");
  });

  it("lets a pick without skipUsed find the same thing every round", async () => {
    // `skipUsed` is the one switch for "do not pick this again". A pick naming a control
    // rather than a post finds the same value each round, and must not be told it has run
    // out -- which would quietly end the loop on round 2.
    const f = withForms("859148", "859149", "859150");
    const used: string[] = [];
    const out = await run(f.page, [repeat(3, [PICK, REPLY_FORM])], {
      usedValues: () => used.slice(),
      markUsed: (_name, value) => used.push(value),
    });

    expect(out.ok).toBe(true);
    expect(used).toEqual(["859148", "859149", "859150"]);
    expect(out.logs.find((l) => l.type === "web_repeat")!.outcome).toBe(
      "3 of 3 round(s) got through",
    );
  });

  it("names the round and the post in the summary of what went wrong", async () => {
    const f = withForms("859148");
    const out = await run(f.page, [repeat(2, [PICK, REPLY_FORM])], { usedValues: () => [] });
    expect(out.logs.find((l) => l.type === "web_repeat")!.outcome).toContain("2/2 859149");
  });

  it("stops at the first failure when told not to carry on", async () => {
    const f = withForms("859148", "859150");
    const used: string[] = [];
    const out = await run(f.page, [repeat(3, [PICK, REPLY_FORM], { continueOnError: false })], {
      usedValues: () => used.slice(),
      markUsed: (_name, value) => used.push(value),
    });

    // The third post is never reached, even though its form is there
    expect(used).toEqual(["859148"]);
    expect(
      out.logs.filter((l) => l.type === "web_pick" && l.label.includes("#form-")),
    ).toHaveLength(2);
    expect(out.logs.find((l) => l.type === "web_repeat")!.outcome).toContain("1 of 3");
  });

  it("fails the loop when no round got through at all", async () => {
    const f = withForms();
    const out = await run(f.page, [repeat(2, [PICK, REPLY_FORM])], { usedValues: () => [] });
    expect(out.ok).toBe(false);
    expect(out.logs.find((l) => l.type === "web_repeat")!.error).toMatch(/0 of 2 round\(s\)/);
  });

  it("does not carry a value out of the round it belongs to", async () => {
    const f = fakePage(LIST);
    const out = await run(
      f.page,
      [repeat(1, [PICK]), { type: "web_goto", url: `${HOME}{postId}` }],
      { usedValues: () => [] },
    );
    // The brace survives to the address, rather than the round's post leaking into it
    expect(f.visited.at(-1)).toBe(`${HOME}{postId}`);
    expect(out.ok).toBe(true);
  });
});

describe("web_goto and web_back", () => {
  it("fills the round's value into the address and goes there", async () => {
    const f = fakePage(LIST);
    const out = await run(
      f.page,
      [repeat(1, [PICK, { type: "web_goto", url: `${HOME}post-{postId}-1` }])],
      { usedValues: () => [] },
    );
    expect(out.ok).toBe(true);
    expect(f.visited.at(-1)).toBe(`${HOME}post-859148-1`);
    expect(out.logs.find((l) => l.type === "web_goto")!.label).toBe(
      `Go to ${HOME}post-859148-1`,
    );
  });

  it("refuses an address that is not http, before the browser is asked for anything", async () => {
    const f = fakePage();
    const out = await run(f.page, [{ type: "web_goto", url: "javascript:alert(1)" }]);
    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toMatch(/must start with http/);
    expect(f.visited).toEqual([HOME]);
  });

  it("fails on a blank address rather than reloading where it already is", async () => {
    const f = fakePage();
    const out = await run(f.page, [{ type: "web_goto", url: "   " }]);
    expect(out.logs[0].error).toBe("no address given");
    expect(f.visited).toEqual([HOME]);
  });

  it("fails when the page never moved, which is a load that did not happen", async () => {
    const f = fakePage();
    f.failNavigation("net::ERR_TIMED_OUT");
    const out = await run(f.page, [{ type: "web_goto", url: `${HOME}post-1-1` }]);
    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toMatch(/could not open .* \(net::ERR_TIMED_OUT/);
  });

  it("fails the step when a challenge on the new page will not pass", async () => {
    const f = fakePage();
    const out = await run(f.page, [{ type: "web_goto", url: `${HOME}post-1-1` }], {
      solveChallenge: async () => false,
    });
    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toMatch(/challenge on the new page could not be passed/);
  });

  it("goes back to the page before it", async () => {
    const f = fakePage();
    const out = await run(f.page, [
      { type: "web_goto", url: `${HOME}post-1-1` },
      { type: "web_back" },
    ]);
    expect(out.ok).toBe(true);
    expect(f.visited).toEqual([HOME]);
    expect(out.logs[1].outcome).toBe(`went back to ${HOME}`);
  });

  it("fails going back when there is no previous page", async () => {
    const f = fakePage();
    const out = await run(f.page, [{ type: "web_back" }]);
    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toMatch(/no previous page/);
  });
});

describe("web_read", () => {
  it("reads the post into a name for a later step to quote", async () => {
    const f = fakePage({ ".post-content": ["  the first post's body text  "] });
    const out = await run(f.page, [
      { type: "web_read", selector: ".post-content", varName: "postText" },
      { type: "web_goto", url: `${HOME}?q={postText}` },
    ]);

    expect(out.logs[0].outcome).toContain("into {postText}");
    expect(f.visited.at(-1)).toBe(`${HOME}?q=the first post's body text`);
  });

  it("cuts the text to the length it was given", async () => {
    const f = fakePage({ ".post-content": ["x".repeat(5000)] });
    const out = await run(f.page, [
      { type: "web_read", selector: ".post-content", varName: "postText", maxChars: 50 },
    ]);
    expect(out.logs[0].outcome).toContain("read 50 character(s)");
  });

  it("keeps 1000 characters when it is not told a length", async () => {
    const f = fakePage({ ".post-content": ["x".repeat(5000)] });
    const out = await run(f.page, [
      { type: "web_read", selector: ".post-content", varName: "postText" },
    ]);
    expect(out.logs[0].outcome).toContain("read 1000 character(s)");
  });

  it("fails when there is no such text, rather than handing the AI an empty quote", async () => {
    const f = fakePage({ ".post-content": ["   "] });
    const out = await run(f.page, [
      { type: "web_read", selector: ".post-content", varName: "postText" },
    ]);
    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toMatch(/has any text on the page/);
  });
});
