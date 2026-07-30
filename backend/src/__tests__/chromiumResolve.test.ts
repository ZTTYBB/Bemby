// The stealth browser is downloaded into the data dir, so which build gets launched is a
// filesystem question: newest version wins, and the settings page has to be able to answer
// "is it installed" without an async call into the library.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}));

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let dir: string;
let cf: typeof import("../jobs/cloudflare");

/** Lays down a CloakBrowser cache entry and returns the executable path. */
function fakeDownload(version: string, pro = false): string {
  const exe = path.join(dir, "cloakbrowser", `chromium-${version}${pro ? "-pro" : ""}`, "chrome");
  mkdirSync(path.dirname(exe), { recursive: true });
  writeFileSync(exe, "");
  return exe;
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "bemby-chromium-"));
  process.env.DB_PATH = path.join(dir, "bemby.db");
  delete process.env.PUPPETEER_EXECUTABLE_PATH;
  delete process.env.CLOAKBROWSER_BINARY_PATH;
  delete process.env.CLOAKBROWSER_CACHE_DIR;
  cf = await import("../jobs/cloudflare");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.PUPPETEER_EXECUTABLE_PATH;
  delete process.env.CLOAKBROWSER_BINARY_PATH;
});

describe("chromiumExecutable", () => {
  it("reports nothing installed when the data dir is empty", () => {
    expect(cf.chromiumExecutable()).toBeUndefined();
    expect(cf.isChromiumInstalled()).toBe(false);
  });

  it("finds a downloaded browser under the data dir", () => {
    const exe = fakeDownload("146.0.7680.177.5");
    expect(cf.chromiumExecutable()).toBe(exe);
    expect(cf.isChromiumInstalled()).toBe(true);
  });

  it("launches the newest build after an update, not the one left behind", () => {
    fakeDownload("146.0.7680.177.5");
    const newer = fakeDownload("150.0.7900.10.1");
    expect(cf.chromiumExecutable()).toBe(newer);
  });

  it("compares versions numerically, not as text", () => {
    fakeDownload("146.0.7680.98.1");
    const newer = fakeDownload("146.0.7680.177.5");
    expect(cf.chromiumExecutable()).toBe(newer);
  });

  it("resolves a Pro build the same way as a free one", () => {
    fakeDownload("146.0.7680.177.5");
    const pro = fakeDownload("150.0.7900.10.1", true);
    expect(cf.chromiumExecutable()).toBe(pro);
  });

  // A directory with no executable in it is what a download that died halfway leaves
  // behind; offering it would report a browser that cannot launch.
  it("ignores a cache entry with no executable in it", () => {
    mkdirSync(path.join(dir, "cloakbrowser", "chromium-150.0.7900.10.1"), { recursive: true });
    const exe = fakeDownload("146.0.7680.177.5");
    expect(cf.chromiumExecutable()).toBe(exe);
  });

  it("lets an explicit executable path win over everything", () => {
    fakeDownload("146.0.7680.177.5");
    const pinned = path.join(dir, "my-chrome");
    writeFileSync(pinned, "");
    process.env.CLOAKBROWSER_BINARY_PATH = pinned;
    expect(cf.chromiumExecutable()).toBe(pinned);
  });

  // Kept so a development machine that pinned a local Chromium before the switch to
  // CloakBrowser keeps launching, even though it gives up the fingerprint patches.
  it("still honours the legacy PUPPETEER_EXECUTABLE_PATH pin", () => {
    const pinned = path.join(dir, "dev-chrome");
    writeFileSync(pinned, "");
    process.env.PUPPETEER_EXECUTABLE_PATH = pinned;
    expect(cf.chromiumExecutable()).toBe(pinned);
  });
});
