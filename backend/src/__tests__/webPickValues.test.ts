// The two pure halves of the pick-and-repeat pair: turning what a selector read off a page
// into the candidates a round may choose from, and filling the chosen value into the steps
// after it. Neither needs a browser, and both are where a mis-configured pick actually goes
// wrong -- the real-browser cover for the steps themselves is in webStepsBrowser.test.ts.
import { describe, it, expect } from "vitest";
import { fillVars, keepMatchingText, narrowCollected } from "../jobs/cloudflare";

// A forum index reads like this: post links worth keeping, plus profile and category links
// that match the same selector and are not posts.
const HREFS = [
  "/post-859148-1",
  "/post-859149-1",
  "/user/1234",
  "/post-859148-1",
  "/tags/reviews",
];

const collect = (raw: string[], opts: Partial<Parameters<typeof narrowCollected>[1]> = {}) =>
  narrowCollected(raw, { selector: ".post-list-item a", ...opts });

describe("narrowCollected", () => {
  it("keeps the capture group, and drops what the expression does not describe", () => {
    const got = collect(HREFS, { pattern: "/post-(\\d+)" });
    expect(got.values).toEqual(["859148", "859149"]);
    expect(got.found).toBe(2);
    expect(got.skipped).toBe(0);
  });

  it("keeps the whole match when the expression has no capture group", () => {
    expect(collect(HREFS, { pattern: "post-\\d+" }).values).toEqual(["post-859148", "post-859149"]);
  });

  it("keeps page order and de-duplicates, so a post linked twice is one round", () => {
    // The same href appears at index 0 and 3 -- a list page links a post from its title and
    // again from its last-comment time
    expect(collect(HREFS, { pattern: "/post-(\\d+)" }).values).toHaveLength(2);
  });

  it("keeps the values as read when no expression is given", () => {
    expect(collect(["  one  ", "two"]).values).toEqual(["one", "two"]);
  });

  it("leaves out what the job has already been through, and says how many", () => {
    const got = collect(HREFS, { pattern: "/post-(\\d+)", used: ["859148"] });
    expect(got.values).toEqual(["859149"]);
    expect(got.found).toBe(2);
    expect(got.skipped).toBe(1);
  });

  it("returns an empty list rather than throwing when every value has been used", () => {
    // Nothing new to reply to is a quiet end to the loop, not a failed step: the pick says
    // so, the loop stops there, and the job still counts as having run
    const got = collect(HREFS, { pattern: "/post-(\\d+)", used: ["859148", "859149"] });
    expect(got.values).toEqual([]);
    expect(got.found).toBe(2);
    expect(got.skipped).toBe(2);
  });

  it("reports what was found before the used ones came out, so a log can say 2 of 5", () => {
    const got = collect(["/post-1-1", "/post-2-1", "/post-3-1"], {
      pattern: "/post-(\\d+)",
      used: ["1"],
    });
    expect(got.values).toEqual(["2", "3"]);
    expect(got.found).toBe(3);
    expect(got.skipped).toBe(1);
  });

  it("fails when the selector matched nothing on the page", () => {
    expect(() => collect([])).toThrow(/nothing matching `.post-list-item a` is on the page/);
  });

  it("fails when the expression described none of what was found, naming both", () => {
    expect(() => collect(HREFS, { pattern: "/thread-(\\d+)" })).toThrow(
      /5 element\(s\) matched `.post-list-item a`, but none of them matched `\/thread-\(\\d\+\)`/,
    );
  });

  it("fails on an expression the engine cannot compile, rather than matching nothing", () => {
    expect(() => collect(HREFS, { pattern: "/post-(\\d+" })).toThrow(
      /is not a valid regular expression/,
    );
  });

  it("fails when every element read empty, which is a selector pointing at the wrong thing", () => {
    expect(() => collect(["", "   "])).toThrow(/all of them read empty/);
  });
});

describe("fillVars", () => {
  const vars = new Map([["postId", "859148"]]);

  it("fills the value of the round into an address and a selector", () => {
    expect(fillVars("https://forum.example/post-{postId}-1", vars)).toBe(
      "https://forum.example/post-859148-1",
    );
    expect(fillVars("#reply-{postId}", vars)).toBe("#reply-859148");
  });

  it("fills every mention, not just the first", () => {
    expect(fillVars("{postId}/{postId}", vars)).toBe("859148/859148");
  });

  it("leaves a name no loop is holding alone", () => {
    // `expandCommand`'s placeholders are spelled the same way, so eating unknown names here
    // would quietly swallow a {num:6} or a {uuid} meant for the action
    expect(fillVars("{other}-{postId}", vars)).toBe("{other}-859148");
    expect(fillVars("{uuid}", vars)).toBe("{uuid}");
  });

  it("leaves the text alone when no loop is running", () => {
    expect(fillVars("post-{postId}-1", new Map())).toBe("post-{postId}-1");
  });

  it("takes an empty string without complaint", () => {
    expect(fillVars("", vars)).toBe("");
  });
});

// A selector reaches "every post in the list"; only its text says which of them is a
// giveaway. CSS cannot ask about text at all, so without this a job wanting one kind of post
// has to take the lot and sort it out after navigating -- by which point it has already
// spent a round on the wrong post.
describe("keepMatchingText", () => {
  const LIST = [
    { value: "/post-862176-1", text: "推荐使用商家的dns，还是自己改1.1.1.1？" },
    { value: "/post-862177-1", text: "【抽奖】抽一台8.10到期的DMIT" },
    { value: "/post-862178-1", text: "毕业了，小鸡们出个干净" },
    { value: "/post-862179-1", text: "月末抽奖活动来了" },
  ];

  it("keeps only what reads the wanted words, and keeps the value not the text", () => {
    expect(keepMatchingText(LIST, "抽奖", ".post-title a")).toEqual([
      "/post-862177-1",
      "/post-862179-1",
    ]);
  });

  it("keeps everything when nothing is asked for", () => {
    expect(keepMatchingText(LIST, "", ".post-title a")).toHaveLength(4);
  });

  it("ignores case, so an English tag matches however it is written", () => {
    const rows = [{ value: "/post-1", text: "[GIVEAWAY] free vps" }];
    expect(keepMatchingText(rows, "giveaway", "a")).toEqual(["/post-1"]);
  });

  it("says so rather than picking wrongly when the list holds none of them", () => {
    // Silently returning nothing would surface as "the page did not load", sending whoever
    // reads the log after the wrong thing entirely
    expect(() => keepMatchingText(LIST, "内部优惠", ".post-title a")).toThrow(/none of them read/);
  });

  it("is nothing to filter when the selector matched nothing at all", () => {
    // That case is narrowCollected's to report, and it words it as an empty page
    expect(keepMatchingText([], "抽奖", ".post-title a")).toEqual([]);
  });

  it("hands its result to narrowCollected unchanged, so the regex still applies", () => {
    const kept = keepMatchingText(LIST, "抽奖", ".post-title a");
    expect(narrowCollected(kept, { selector: "a", pattern: "/post-(\\d+)" }).values).toEqual([
      "862177",
      "862179",
    ]);
  });
});
