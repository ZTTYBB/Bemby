// A solver browser that cannot start says nothing about the exit it would have gone out
// through. Before this was separated out, the failure counted as a refusal, so one broken
// browser burned the whole proxy pool and the job reported it as Cloudflare turning every
// exit away -- which sent the operator hunting for a proxy problem that was not there.

const store = new Map<string, string>();
vi.mock("../db/database", () => ({
  db: {
    prepare: (sql: string) => ({
      get: (key: string) =>
        sql.includes("SELECT") && store.has(key) ? { value: store.get(key) } : undefined,
      run: (key: string, value: string) => store.set(key, value),
      all: () => [],
    }),
  },
}));

const launchCfBrowser = vi.fn();
vi.mock("../jobs/cfBrowser", () => ({
  launchCfBrowser: (...args: unknown[]) => launchCfBrowser(...args),
  isChromiumInstalled: () => true,
  chromiumExecutable: () => "/tmp/chrome",
  applyCfFontEnv: () => {},
}));

import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadCheckinUrl } from "../jobs/cloudflare";

const CANDIDATES = [
  { id: "p1", label: "Proxy One", url: "http://1.1.1.1:8080" },
  { id: "p2", label: "Proxy Two", url: "http://2.2.2.2:8080" },
  { id: "p3", label: "Proxy Three", url: "http://3.3.3.3:8080" },
];

// What the keyed build leaves behind when it quits during startup
const SIGTRAP_FAILURE =
  "browserType.launchPersistentContext: Target page, context or browser has been closed " +
  "Browser logs: <launching> /app/data/cloakbrowser/chromium-150.0.7871.114-pro/chrome " +
  "--disable-field-trial-config ... <launched> pid=583 ... handshake failed; returned -1, " +
  "SSL error code 1, net_error -3 <gracefully close start> - [pid=583] <process did exit: " +
  "exitCode=null, signal=SIGTRAP>";

beforeEach(() => {
  store.clear();
  launchCfBrowser.mockReset();
});

describe("a solver browser that cannot start", () => {
  it("refuses no proxy and tries only one exit", async () => {
    launchCfBrowser.mockRejectedValue(new Error(SIGTRAP_FAILURE));

    const res = await loadCheckinUrl("https://example.com/app", undefined, {
      proxyCandidates: CANDIDATES,
      maxWaitMs: 30_000,
    });

    expect(res.ok).toBe(false);
    expect(res.browserFailed).toBe(true);
    // The pool is untouched: nothing here was the exits' doing
    expect(res.refusedProxyIds).toEqual([]);
    expect(res.attempts).toBe(1);
    expect(launchCfBrowser).toHaveBeenCalledTimes(1);
    expect(res.trace?.join(" ")).toContain("could not start");
  });

  it("leads with the licence explanation rather than the Chromium log", async () => {
    launchCfBrowser.mockRejectedValue(new Error(SIGTRAP_FAILURE));

    const res = await loadCheckinUrl("https://example.com/app", undefined, {
      proxyCandidates: CANDIDATES,
      maxWaitMs: 30_000,
    });

    expect(res.reason).toMatch(/licensed browser build quit during startup/);
    expect(res.reason).toMatch(/one browser at a time/);
  });

  it("names a missing binary as such", async () => {
    launchCfBrowser.mockRejectedValue(new Error("Failed to launch: ENOENT /tmp/chrome"));

    const res = await loadCheckinUrl("https://example.com/app", undefined, {
      proxyCandidates: CANDIDATES,
      maxWaitMs: 30_000,
    });

    expect(res.reason).toMatch(/binary could not be started/);
    expect(res.refusedProxyIds).toEqual([]);
  });
});
