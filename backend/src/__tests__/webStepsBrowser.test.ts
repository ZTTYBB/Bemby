// Page steps that reach into the browser, driven against a real one.
//
// These cover a failure that no amount of unit testing catches: anything defined as a named
// function inside a `page.evaluate` body is rewritten by tsx (the dev server's loader) into
// a call to a `__name` helper that exists only on this side, so the body throws on its first
// line. Both callers below swallow that -- a scroll reports "nothing scrolls", a click asks
// the model to judge a screenshot with no grid on it -- which reads as a page that behaved
// oddly rather than as a broken step. Only running the real thing tells them apart.
// The settings row the stub hands back is the tuning one: the pauses a step leaves for a
// real page to settle are dead time against a local one, and they dominate the run.
vi.mock("../db/database", () => ({
  db: {
    prepare: () => ({
      get: () => ({ value: JSON.stringify({ inAppStepMs: 0, inAppSettleMs: 0 }) }),
      run: () => {},
      all: () => [],
    }),
  },
}));

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Browser, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { chromiumExecutable } from "../jobs/cfBrowser";
import { runWebSteps } from "../jobs/cloudflare";

// The keyed build quits without a licence seat, so these drive the unlicensed one
const exe = chromiumExecutable("free");

const page = (html: string) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<body style="margin:0">${html}</body>`)}`;

describe.skipIf(!exe)("page steps in a real browser", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: exe, headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const open = async (html: string, size = { width: 800, height: 600 }): Promise<Page> => {
    const p = await browser.newPage({ viewport: size });
    await p.goto(page(html), { waitUntil: "domcontentloaded" });
    return p;
  };

  it(
    "scrolls the page, rather than reporting that nothing scrolls",
    async () => {
      const p = await open(`<div style="height:3000px">tall</div>`);
      const run = await runWebSteps(p, [{ type: "web_scroll", y: 500 }], Date.now() + 30_000, {});
      expect(run.logs[0].error).toBeUndefined();
      expect(run.logs[0].outcome).toContain("500");
      expect(await p.evaluate(() => window.scrollY)).toBe(500);
      await p.close();
    },
    60_000,
  );

  it(
    "corrects the wide guess against the close-up, and clicks what it settled on",
    async () => {
      // A 22px box centred at 355,457 -- the size and place of a Turnstile checkbox
      const p = await open(
        `<input id="cb" type="checkbox" style="position:absolute;left:344px;top:446px;width:22px;height:22px;margin:0">` +
          `<span style="position:absolute;left:385px;top:450px">Verify you are human</span>`,
        { width: 945, height: 939 },
      );
      const truth = await p.evaluate(() => {
        const r = document.getElementById("cb")!.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });

      const shots: string[] = [];
      let pass = 0;
      const run = await runWebSteps(
        p,
        [{ type: "ai_web_click_xy", hint: "the verify you are human checkbox" }],
        Date.now() + 30_000,
        {
          aiLocate: async (image, prompt) => {
            shots.push(image);
            pass++;
            // The wide pass answers off-target, the way the live model did; the close-up
            // is the one that has to be believed
            return pass === 1
              ? '{"x": 360, "y": 485}'
              : `{"x": ${truth.x}, "y": ${truth.y}}`;
          },
        },
      );

      expect(run.logs[0].error).toBeUndefined();
      expect(pass).toBe(2);
      // The close-up is a window on the page, so it must be the smaller picture of the two
      expect(shots[1].length).toBeLessThan(shots[0].length);
      expect(run.logs[0].outcome).toContain(`AI clicked ${truth.x},${truth.y}`);
      expect(run.logs[0].outcome).toContain("close-up moved it");
      expect(await p.evaluate(() => (document.getElementById("cb") as HTMLInputElement).checked))
        .toBe(true);
      // The ring drawn over the click is left for this step's screenshot and then taken off
      expect(run.logs[0].screenshot).toBeTruthy();
      expect(await p.evaluate(() => document.querySelectorAll(".__bemby_mark").length)).toBe(0);
      await p.close();
    },
    60_000,
  );

  it(
    "keeps the wide guess when the close-up cannot see the target, rather than reading null as 0,0",
    async () => {
      const p = await open(`<button id="b" style="position:absolute;left:300px;top:200px">go</button>`);
      const replies: string[] = ['{"x": 360, "y": 485}', '{"x": null, "y": null, "what": "not in view"}'];
      let pass = 0;
      const run = await runWebSteps(
        p,
        [{ type: "ai_web_click_xy", hint: "the go button" }],
        Date.now() + 30_000,
        { aiLocate: async () => replies[pass++] },
      );
      expect(run.logs[0].error).toBeUndefined();
      expect(run.logs[0].outcome).toContain("AI clicked 360,485");
      expect(run.logs[0].outcome).toContain("could not see it");
      await p.close();
    },
    60_000,
  );

  it(
    "does not tell the close-up what the wide pass answered, which is what made it echo",
    async () => {
      const p = await open(`<button id="b" style="position:absolute;left:300px;top:200px">go</button>`);
      const prompts: string[] = [];
      let pass = 0;
      await runWebSteps(p, [{ type: "ai_web_click_xy" }], Date.now() + 30_000, {
        aiLocate: async (_image, prompt) => {
          prompts.push(prompt);
          return pass++ === 0 ? '{"x": 360, "y": 485}' : '{"x": 312, "y": 210}';
        },
      });
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).not.toContain("360");
      expect(prompts[1]).not.toContain("485");
      await p.close();
    },
    60_000,
  );

  it(
    "passes the Turnstile step on a page that shows no checkbox",
    async () => {
      // Turnstile clears itself for an address it likes, often without drawing a checkbox,
      // so nothing to tick is nothing to do -- not a failed step.
      const p = await open(`<div>no widget here</div>`);
      const run = await runWebSteps(p, [{ type: "web_turnstile" }], Date.now() + 30_000, {});
      expect(run.logs[0].error).toBeUndefined();
      expect(run.ok).toBe(true);
      expect(run.logs[0].outcome).toContain("no Turnstile widget");
      await p.close();
    },
    60_000,
  );

  it(
    "ticks the checkbox where the widget sits, and waits for its token",
    async () => {
      // A widget rendered into the site's own element: a sized wrapper holding nothing but
      // the hidden response field, which is the shape the CDP lookup cannot help with and
      // the ancestor fallback has to handle.
      const p = await open(
        `<div id="w" style="width:300px;height:65px;background:#eee"` +
          ` onclick="document.getElementsByName('cf-turnstile-response')[0].value='tok-1'">` +
          `<input type="hidden" name="cf-turnstile-response"></div>`,
      );
      const run = await runWebSteps(p, [{ type: "web_turnstile" }], Date.now() + 30_000, {});
      expect(run.logs[0].error).toBeUndefined();
      expect(run.logs[0].outcome).toContain("token issued");
      await p.close();
    },
    60_000,
  );

  it(
    "leaves a widget that has already solved itself alone",
    async () => {
      const p = await open(
        `<div style="width:300px;height:65px"` +
          ` onclick="window.__pressed = true">` +
          `<input type="hidden" name="cf-turnstile-response" value="tok-already"></div>`,
      );
      const run = await runWebSteps(p, [{ type: "web_turnstile" }], Date.now() + 30_000, {});
      expect(run.logs[0].outcome).toContain("already solved");
      expect(await p.evaluate(() => (window as any).__pressed)).toBeUndefined();
      await p.close();
    },
    60_000,
  );

  // A forum index, cut down to the shape that matters: post links to read ids off, one link
  // that is not a post, a control per post standing in for its reply form, and the body of
  // the post a round would be replying to.
  const LIST = `
    <ul>
      <li class="post-list-item"><div class="post-title"><a href="/post-859148-1">one</a></div></li>
      <li class="post-list-item"><div class="post-title"><a href="/post-859149-1">two</a></div></li>
      <li class="post-list-item"><div class="post-title"><a href="/user/1234">a profile</a></div></li>
    </ul>
    <div class="post-content">Has anyone tried this on a small VPS?</div>
    <button id="reply-859148" onclick="window.__hits=(window.__hits||[]).concat('859148')">r1</button>
    <button id="reply-859149" onclick="window.__hits=(window.__hits||[]).concat('859149')">r2</button>`;

  const PICK_POST = {
    type: "web_pick" as const,
    selector: ".post-list-item a",
    varName: "postId",
    attribute: "href",
    pattern: "/post-(\\d+)",
    skipUsed: true,
  };

  it(
    "picks a post per round and fills {postId} into the steps that follow",
    async () => {
      const p = await open(LIST);
      const used: string[] = [];
      const run = await runWebSteps(
        p,
        [
          {
            type: "web_repeat",
            times: 2,
            steps: [PICK_POST, { type: "web_button", selector: "#reply-{postId}" }],
          },
        ],
        Date.now() + 30_000,
        { usedValues: () => used.slice(), markUsed: (_name, value) => used.push(value) },
      );

      expect(run.ok).toBe(true);
      // The profile link matched the selector but not the pattern, so it is not an id
      const picks = run.logs.filter((l) => l.type === "web_pick");
      expect(picks[0].outcome).toContain("picked 859148 for {postId}, out of 2 to choose from");
      expect(await p.evaluate(() => (window as any).__hits)).toEqual(["859148", "859149"]);
      // A round's steps log under it, labelled with the round and the post it settled on
      const presses = run.logs.filter((l) => l.type === "web_button");
      expect(presses.map((l) => l.iteration)).toEqual(["1/2 859148", "2/2 859149"]);
      expect(presses[0].label).toBe("Press `#reply-859148`");
      expect(used).toEqual(["859148", "859149"]);
      await p.close();
    },
    60_000,
  );

  it(
    "leaves out an id the job has already been through",
    async () => {
      const p = await open(LIST);
      const used: string[] = [];
      const run = await runWebSteps(
        p,
        [
          {
            type: "web_repeat",
            times: 1,
            steps: [PICK_POST, { type: "web_button", selector: "#reply-{postId}" }],
          },
        ],
        Date.now() + 30_000,
        { usedValues: () => ["859148"], markUsed: (_name, value) => used.push(value) },
      );

      expect(run.ok).toBe(true);
      expect(run.logs[1].outcome).toContain("1 of 2 already used");
      expect(await p.evaluate(() => (window as any).__hits)).toEqual(["859149"]);
      expect(used).toEqual(["859149"]);
      await p.close();
    },
    60_000,
  );

  it(
    "carries on after a round that fails, and does not remember that post as used",
    async () => {
      // The first post picked has nothing to press, so that round cannot finish
      const p = await open(LIST.replace(`<button id="reply-859148"`, `<button id="gone-859148"`));
      const used: string[] = [];
      const run = await runWebSteps(
        p,
        [
          {
            type: "web_repeat",
            times: 2,
            steps: [PICK_POST, { type: "web_button", selector: "#reply-{postId}" }],
          },
        ],
        Date.now() + 30_000,
        { usedValues: () => used.slice(), markUsed: (_name, value) => used.push(value) },
      );

      // One round short is not the action failing: the other post still got its reply
      expect(run.ok).toBe(true);
      const loop = run.logs.find((l) => l.type === "web_repeat")!;
      expect(loop.error).toBeUndefined();
      expect(loop.outcome).toContain("1 of 2");
      expect(loop.outcome).toContain("1 failed");
      expect(await p.evaluate(() => (window as any).__hits)).toEqual(["859149"]);
      expect(used).toEqual(["859149"]);
      await p.close();
    },
    60_000,
  );

  it(
    "scrolls to an element rather than a distance, and reports where it landed",
    async () => {
      // The case pixels cannot serve: the target sits below content of unknown length
      const p = await open(
        `<div style="height:3000px">filler</div>` +
          `<button id="reply" style="height:40px">reply</button>` +
          `<div style="height:2000px">more</div>`,
      );
      const run = await runWebSteps(
        p,
        [{ type: "web_scroll_to", selector: "#reply" }],
        Date.now() + 30_000,
        {},
      );

      expect(run.ok).toBe(true);
      expect(run.logs[0].outcome).toContain("scrolled to `#reply`");
      // In view, and near the middle rather than just barely on screen
      const box = await p.evaluate(() => {
        const r = document.getElementById("reply")!.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, height: innerHeight };
      });
      expect(box.top).toBeGreaterThan(0);
      expect(box.bottom).toBeLessThan(box.height);
      await p.close();
    },
    60_000,
  );

  it(
    "reaches a target inside a scrollable panel, not just the page",
    async () => {
      // A distance scrolls the page; the element here moves only if its own panel does
      const p = await open(
        `<div id="panel" style="height:200px;overflow:auto">` +
          `<div style="height:1500px">filler</div>` +
          `<button id="deep">deep</button></div>`,
      );
      const run = await runWebSteps(
        p,
        [{ type: "web_scroll_to", selector: "#deep" }],
        Date.now() + 30_000,
        {},
      );

      expect(run.ok).toBe(true);
      expect(await p.evaluate(() => document.getElementById("panel")!.scrollTop)).toBeGreaterThan(0);
      await p.close();
    },
    60_000,
  );

  it(
    "waits for a target the page has yet to draw",
    async () => {
      const p = await open(`<div style="height:2000px">filler</div>`);
      await p.evaluate(() => {
        setTimeout(() => {
          const b = document.createElement("button");
          b.id = "late";
          document.body.appendChild(b);
        }, 400);
      });
      const run = await runWebSteps(
        p,
        [{ type: "web_scroll_to", selector: "#late", waitMs: 5000 }],
        Date.now() + 30_000,
        {},
      );
      expect(run.ok).toBe(true);
      await p.close();
    },
    60_000,
  );

  it(
    "fails when the target never appears, rather than scrolling somewhere arbitrary",
    async () => {
      const p = await open(`<div style="height:2000px">filler</div>`);
      const run = await runWebSteps(
        p,
        [{ type: "web_scroll_to", selector: "#nope", waitMs: 300 }],
        Date.now() + 30_000,
        {},
      );
      expect(run.ok).toBe(false);
      expect(run.logs[0].error).toMatch(/appeared to scroll to/);
      await p.close();
    },
    60_000,
  );

  it(
    "reads the post body off the page for a later step to quote",
    async () => {
      const p = await open(LIST);
      const run = await runWebSteps(
        p,
        [{ type: "web_read", selector: ".post-content", varName: "postText" }],
        Date.now() + 30_000,
        {},
      );
      expect(run.ok).toBe(true);
      expect(run.logs[0].outcome).toContain("Has anyone tried this on a small VPS?");
      await p.close();
    },
    60_000,
  );

  it(
    "refuses a loop inside a loop rather than recursing",
    async () => {
      const p = await open(LIST);
      const run = await runWebSteps(
        p,
        [
          {
            type: "web_repeat",
            times: 2,
            steps: [{ type: "web_repeat", times: 2, steps: [{ type: "web_back" }] }],
          },
        ],
        Date.now() + 30_000,
        { usedValues: () => [] },
      );

      expect(run.ok).toBe(false);
      expect(run.failure).toMatch(/cannot be put inside another loop/);
      await p.close();
    },
    60_000,
  );

  it(
    "fails a pick whose pattern matches none of the elements it found",
    async () => {
      const p = await open(LIST);
      const run = await runWebSteps(
        p,
        [{ ...PICK_POST, pattern: "/thread-(\\d+)" }],
        Date.now() + 30_000,
        {},
      );
      expect(run.ok).toBe(false);
      expect(run.logs[0].error).toContain("none of them matched");
      await p.close();
    },
    60_000,
  );

  it(
    "fails the step when the ruler cannot be drawn, instead of asking for a blind guess",
    async () => {
      const p = await open(`<div>plain</div>`);
      // A page with no body is the one case that leaves nothing to draw the grid into
      await p.evaluate(() => document.body.remove());
      const run = await runWebSteps(
        p,
        [{ type: "ai_web_click_xy", hint: "anything" }],
        Date.now() + 30_000,
        { aiLocate: async () => '{"x": 10, "y": 10}' },
      );
      expect(run.ok).toBe(false);
      expect(run.logs[0].error).toMatch(/grid/i);
      await p.close();
    },
    60_000,
  );
});
