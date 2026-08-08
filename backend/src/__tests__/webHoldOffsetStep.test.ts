// Pressing and holding at an offset from an anchor: where the pointer actually goes, that
// the anchor itself is never pressed, and that the point is marked on the page so this
// step's screenshot shows the operator what to correct.
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

type Box = { x: number; y: number; width: number; height: number };

/**
 * A page that knows where its elements sit and what was drawn on it. `boxes` is what the
 * anchor measures to; anything not in it is not on the page.
 */
function fakePage(boxes: Record<string, Box>, view = { w: 1280, h: 720 }) {
  const pointer: Array<{ at: string; x?: number; y?: number }> = [];
  const marks: Array<{ x: number; y: number; label: string }> = [];

  const page = {
    title: async () => "",
    url: () => "https://widget.example/",
    screenshot: async () => Buffer.from("a jpeg, near enough"),
    keyboard: { press: async () => {}, type: async () => {} },
    mouse: {
      move: async (x: number, y: number) => pointer.push({ at: "move", x, y }),
      click: async (x: number, y: number) => pointer.push({ at: "click", x, y }),
      down: async () => pointer.push({ at: "down" }),
      up: async () => pointer.push({ at: "up" }),
    },
    evaluate: async (fn: unknown, arg?: unknown) => {
      const body = String(fn);
      // The anchor's box
      if (typeof arg === "string") return boxes[arg] ?? null;
      if (arg && typeof arg === "object") {
        const o = arg as { px: number; py: number; label?: string };
        // The marker drawn for the screenshot
        if ("label" in o) {
          marks.push({ x: o.px, y: o.py, label: o.label as string });
          return undefined;
        }
        // What is painted at the point
        if (body.includes("elementFromPoint")) return '<div> "hold me"';
      }
      if (body.includes("innerWidth")) return view;
      if (body.includes("challenge-")) return false;
      return "a page with plenty of readable text on it";
    },
  };
  return { page: page as unknown as Page, pointer, marks };
}

const run = (page: Page, steps: WebStep[]) => runWebSteps(page, steps, Date.now() + 30_000, {});

const ANCHOR = ".captcha-frame";
/** 200 wide, 100 tall, at 400,300 -- so its centre is 500,350. */
const BOXES = { [ANCHOR]: { x: 400, y: 300, width: 200, height: 100 } };

const STEP: WebStep = {
  type: "web_hold_offset",
  selector: ANCHOR,
  x: 30,
  y: -20,
  holdMs: 100,
};

describe("web_hold_offset", () => {
  it("presses at the offset from the anchor's centre by default", async () => {
    const f = fakePage(BOXES);
    const out = await run(f.page, [STEP]);

    expect(out.ok).toBe(true);
    // Approached, then pressed at the point itself
    expect(f.pointer.map((p) => p.at)).toEqual(["move", "move", "down", "up"]);
    expect(f.pointer[1]).toEqual({ at: "move", x: 530, y: 330 });
  });

  it("measures from the top-left corner when asked to", async () => {
    const f = fakePage(BOXES);
    await run(f.page, [{ ...STEP, from: "topLeft" } as WebStep]);

    expect(f.pointer[1]).toEqual({ at: "move", x: 430, y: 280 });
  });

  it("presses the anchor's own centre when there is no offset", async () => {
    const f = fakePage(BOXES);
    await run(f.page, [{ ...STEP, x: 0, y: 0 } as WebStep]);

    expect(f.pointer[1]).toEqual({ at: "move", x: 500, y: 350 });
  });

  it("keeps the button down for the time it was given, then lets go", async () => {
    const f = fakePage(BOXES);
    const started = Date.now();
    const out = await run(f.page, [STEP]);

    expect(out.ok).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(f.pointer.at(-1)).toEqual({ at: "up" });
  });

  it("does not hold past the time the whole run has left", async () => {
    const f = fakePage(BOXES);
    const started = Date.now();
    const out = await runWebSteps(
      f.page,
      [{ ...STEP, holdMs: 60_000 } as WebStep],
      Date.now() + 200,
      {},
    );

    expect(out.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(f.pointer.at(-1)).toEqual({ at: "up" });
  });

  it("marks the point it pressed, so the screenshot shows where to correct", async () => {
    const f = fakePage(BOXES);
    await run(f.page, [STEP]);

    expect(f.marks).toEqual([{ x: 530, y: 330, label: "held" }]);
  });

  it("says where it pressed, and what it was measured from", async () => {
    const f = fakePage(BOXES);
    const out = await run(f.page, [STEP]);

    expect(out.logs[0].outcome).toBe(
      'held 530,330 for 0.1s -- 30,-20 from the centre of `.captcha-frame`, on <div> "hold me"',
    );
  });

  it("fills the anchor from the round's own names", async () => {
    const f = fakePage({ "#box-7": { x: 0, y: 0, width: 100, height: 100 } });
    const out = await run(f.page, [
      { type: "web_set", varName: "n", value: "7" },
      { ...STEP, selector: "#box-{n}", x: 10, y: 10 } as WebStep,
    ]);

    expect(out.ok).toBe(true);
    expect(f.pointer[1]).toEqual({ at: "move", x: 60, y: 60 });
  });

  it("fails when the anchor is not on the page, without touching the pointer", async () => {
    const f = fakePage(BOXES);
    const out = await run(f.page, [{ ...STEP, selector: "#gone" } as WebStep]);

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toBe("nothing matching `#gone` is on the page");
    expect(f.pointer).toEqual([]);
  });

  it("refuses an offset that lands off the page, and says what it measured", async () => {
    const f = fakePage(BOXES, { w: 800, h: 600 });
    const out = await run(f.page, [{ ...STEP, x: 900, y: 0 } as WebStep]);

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toContain("lands at 1400,350");
    expect(out.logs[0].error).toContain("800×600");
    expect(out.logs[0].error).toContain("200×100 at 400,300");
    expect(f.pointer).toEqual([]);
  });

  it("refuses a step with no anchor named", async () => {
    const f = fakePage(BOXES);
    const out = await run(f.page, [{ ...STEP, selector: "" } as WebStep]);

    expect(out.ok).toBe(false);
    expect(out.logs[0].error).toMatch(/no CSS selector given for the anchor/);
  });
});
