// The browser is downloaded into the data dir, so which build gets launched is a
// filesystem question: newest revision wins, and an install left by the older
// Alpine-based image still resolves until it is replaced.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}));

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let dir: string;
let cf: typeof import("../jobs/cloudflare");

/** Lays down a Playwright-style browser tree and returns the executable path. */
function fakeDownload(revision: number): string {
  const exe = path.join(dir, "pw-browsers", `chromium-${revision}`, "chrome-linux", "chrome");
  mkdirSync(path.dirname(exe), { recursive: true });
  writeFileSync(exe, "");
  return exe;
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "bemby-chromium-"));
  process.env.DB_PATH = path.join(dir, "bemby.db");
  delete process.env.PUPPETEER_EXECUTABLE_PATH;
  cf = await import("../jobs/cloudflare");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

describe("chromiumExecutable", () => {
  it("reports nothing installed when the data dir is empty", () => {
    expect(cf.chromiumExecutable()).toBeUndefined();
    expect(cf.isChromiumInstalled()).toBe(false);
  });

  it("finds a downloaded browser under the data dir", () => {
    const exe = fakeDownload(1228);
    expect(cf.chromiumExecutable()).toBe(exe);
    expect(cf.isChromiumInstalled()).toBe(true);
  });

  it("launches the newest revision after an update, not the one left behind", () => {
    fakeDownload(1228);
    const newer = fakeDownload(1234);
    expect(cf.chromiumExecutable()).toBe(newer);
  });

  it("compares revisions numerically, not as text", () => {
    fakeDownload(998);
    const newer = fakeDownload(1234);
    expect(cf.chromiumExecutable()).toBe(newer);
  });

  // The apk root holds a musl binary. On a glibc image it cannot be executed at all, so
  // offering it would report a browser that never launches and block the download of one
  // that does. (This suite runs on glibc; on Alpine the root is still resolved.)
  it("ignores an apk-root install left behind on a glibc system", () => {
    const legacy = path.join(dir, "cf-chromium", "usr/lib/chromium/chrome");
    mkdirSync(path.dirname(legacy), { recursive: true });
    writeFileSync(legacy, "");
    expect(cf.chromiumExecutable()).toBeUndefined();
    expect(cf.isChromiumInstalled()).toBe(false);
  });

  it("uses the downloaded browser when an apk root is also present", () => {
    const legacy = path.join(dir, "cf-chromium", "usr/lib/chromium/chrome");
    mkdirSync(path.dirname(legacy), { recursive: true });
    writeFileSync(legacy, "");
    const downloaded = fakeDownload(1234);
    expect(cf.chromiumExecutable()).toBe(downloaded);
  });

  it("lets an explicit executable path win over everything", () => {
    fakeDownload(1234);
    const pinned = path.join(dir, "my-chrome");
    writeFileSync(pinned, "");
    process.env.PUPPETEER_EXECUTABLE_PATH = pinned;
    expect(cf.chromiumExecutable()).toBe(pinned);
  });
});
