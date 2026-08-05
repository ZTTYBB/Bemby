// What a `web_collect` has already handed to a loop. A job that replies to forum posts to
// earn points must not reply to the same post twice, and must not be held back by what a
// different account's copy of the job has already done -- so the keying is the point of
// these, along with the row not growing without bound.
const rows = new Map<string, string>();

vi.mock("../db/database", () => ({
  db: {
    prepare: (sql: string) => ({
      get: (key: string) =>
        sql.includes("SELECT") && rows.has(key) ? { value: rows.get(key) } : undefined,
      run: (...args: string[]) => {
        if (sql.includes("DELETE")) {
          // The only LIKE this module uses is a `prefix:%` wipe
          const prefix = args[0].replace(/%$/, "");
          for (const key of [...rows.keys()]) if (key.startsWith(prefix)) rows.delete(key);
          return;
        }
        rows.set(args[0], args[1]);
      },
      all: () => [],
    }),
  },
}));

import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetWebValues, rememberWebValue, usedWebValues } from "../jobs/webMemory";

beforeEach(() => {
  rows.clear();
});

describe("usedWebValues", () => {
  it("starts empty for a job that has never run", () => {
    expect(usedWebValues(1, "postId")).toEqual([]);
  });

  it("gives nothing back when there is no job to key on", () => {
    // A manual run outside a job has nowhere to keep this, and must not read another's list
    expect(usedWebValues(undefined, "postId")).toEqual([]);
  });

  it("survives a row that is not the JSON array it should be", () => {
    rows.set("web_used:1:postId", "not json");
    expect(usedWebValues(1, "postId")).toEqual([]);
    rows.set("web_used:1:postId", '{"postId":"859148"}');
    expect(usedWebValues(1, "postId")).toEqual([]);
  });

  it("drops entries in the row that are not strings", () => {
    rows.set("web_used:1:postId", '["859148", 859149, null]');
    expect(usedWebValues(1, "postId")).toEqual(["859148"]);
  });
});

describe("rememberWebValue", () => {
  it("keeps what a job has been through, in the order it got there", () => {
    rememberWebValue(1, "postId", "859148");
    rememberWebValue(1, "postId", "859149");
    expect(usedWebValues(1, "postId")).toEqual(["859148", "859149"]);
  });

  it("keeps each job's list to itself, so another account still has the whole page to work", () => {
    rememberWebValue(1, "postId", "859148");
    expect(usedWebValues(2, "postId")).toEqual([]);
    rememberWebValue(2, "postId", "859149");
    expect(usedWebValues(1, "postId")).toEqual(["859148"]);
    expect(usedWebValues(2, "postId")).toEqual(["859149"]);
  });

  it("keeps each collected name to itself within a job", () => {
    rememberWebValue(1, "postId", "859148");
    rememberWebValue(1, "threadId", "42");
    expect(usedWebValues(1, "postId")).toEqual(["859148"]);
    expect(usedWebValues(1, "threadId")).toEqual(["42"]);
  });

  it("does not record the same value twice, and moves it to the end", () => {
    // Position matters: the cap drops from the front, so a value seen again is the freshest
    // thing in the list and must not be the next one thrown away
    rememberWebValue(1, "postId", "859148");
    rememberWebValue(1, "postId", "859149");
    rememberWebValue(1, "postId", "859148");
    expect(usedWebValues(1, "postId")).toEqual(["859149", "859148"]);
  });

  it("drops the oldest once the list is full, rather than growing for ever", () => {
    for (let n = 0; n < 1005; n++) rememberWebValue(1, "postId", `post-${n}`);
    const kept = usedWebValues(1, "postId");
    expect(kept).toHaveLength(1000);
    expect(kept[0]).toBe("post-5");
    expect(kept.at(-1)).toBe("post-1004");
  });

  it("writes nothing when there is no job, or nothing to record", () => {
    rememberWebValue(undefined, "postId", "859148");
    rememberWebValue(1, "postId", "");
    expect(rows.size).toBe(0);
  });
});

describe("forgetWebValues", () => {
  it("clears every name a job kept, and leaves the other jobs alone", () => {
    rememberWebValue(1, "postId", "859148");
    rememberWebValue(1, "threadId", "42");
    rememberWebValue(2, "postId", "859149");

    forgetWebValues(1);

    expect(usedWebValues(1, "postId")).toEqual([]);
    expect(usedWebValues(1, "threadId")).toEqual([]);
    expect(usedWebValues(2, "postId")).toEqual(["859149"]);
  });

  it("does not touch a job whose id merely starts with the same digits", () => {
    // `web_used:1:%` must not reach `web_used:12:postId`, which the colon is there to stop
    rememberWebValue(12, "postId", "859148");
    forgetWebValues(1);
    expect(usedWebValues(12, "postId")).toEqual(["859148"]);
  });
});
