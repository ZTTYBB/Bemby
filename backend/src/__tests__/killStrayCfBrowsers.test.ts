// The panel's restart kills browser processes an earlier backend left behind. It picks them
// by executable, so the test that matters is the negative one: a process that is not ours
// must survive, however much it looks like one.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { killStrayCfBrowsers } from "../jobs/cfBrowser";

const SLEEP = "/bin/sleep";
const linux = process.platform === "linux" && existsSync(SLEEP);

let cache: string;
const previous = process.env.CLOAKBROWSER_CACHE_DIR;
const children: ChildProcess[] = [];

/** Runs `sleep` from `dir`, so its /proc exe link points there. */
function sleepFrom(dir: string): ChildProcess {
  const exe = path.join(dir, "chrome");
  copyFileSync(SLEEP, exe);
  const child = spawn(exe, ["30"]);
  children.push(child);
  return child;
}

const alive = (child: ChildProcess): boolean => {
  try {
    process.kill(child.pid!, 0);
    return true;
  } catch {
    return false;
  }
};

beforeEach(() => {
  cache = mkdtempSync(path.join(os.tmpdir(), "bemby-cloak-"));
  process.env.CLOAKBROWSER_CACHE_DIR = path.join(cache, "cloakbrowser");
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  rmSync(cache, { recursive: true, force: true });
  if (previous === undefined) delete process.env.CLOAKBROWSER_CACHE_DIR;
  else process.env.CLOAKBROWSER_CACHE_DIR = previous;
});

describe.skipIf(!linux)("killing browsers left behind", () => {
  it("kills what runs from the browser directory and nothing else", async () => {
    const browserDir = path.join(cache, "cloakbrowser", "chromium-150-pro");
    mkdirSync(browserDir, { recursive: true });

    const ours = sleepFrom(browserDir);
    const theirs = sleepFrom(cache); // beside it, not under it

    expect(killStrayCfBrowsers().killed).toBe(1);
    // The kill is delivered by the kernel; give it a moment to be reaped
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(ours)).toBe(false);
    expect(alive(theirs)).toBe(true);
  });

  it("finds nothing to kill when no browser has run", () => {
    expect(killStrayCfBrowsers().killed).toBe(0);
  });
});
