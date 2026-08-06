// Browser profiles are the one piece of state a run carries over from the last one, so
// clearing them is the first thing to try when a browser starts failing for no reason that
// changed elsewhere. One profile that cannot be removed must not stop the others going.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}));

import { cfProfileCount, cfProfileKey, clearCfProfiles } from "../jobs/cfBrowser";

const root = mkdtempSync(path.join(os.tmpdir(), "cfprofiles-"));
const profiles = path.join(root, "cf-profiles");

beforeEach(() => {
  // dataDir() is read from DB_PATH on every call, so each test can point it somewhere new
  process.env.DB_PATH = path.join(root, "bemby.db");
  rmSync(profiles, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

function makeProfile(name: string) {
  const dir = path.join(profiles, name);
  mkdirSync(path.join(dir, "Default"), { recursive: true });
  writeFileSync(path.join(dir, ".bemby-last-used"), "");
  // What a browser that was killed leaves behind
  writeFileSync(path.join(dir, "SingletonLock"), "");
  return dir;
}

describe("clearCfProfiles", () => {
  it("removes every profile and says how many went", () => {
    makeProfile("direct");
    makeProfile("a1b2c3");
    makeProfile("d4e5f6");
    expect(cfProfileCount()).toBe(3);

    expect(clearCfProfiles()).toEqual({ removed: 3 });
    expect(cfProfileCount()).toBe(0);
    expect(existsSync(path.join(profiles, "direct"))).toBe(false);
  });

  it("takes the stale lock files with them", () => {
    const dir = makeProfile("direct");
    expect(existsSync(path.join(dir, "SingletonLock"))).toBe(true);
    clearCfProfiles();
    expect(existsSync(dir)).toBe(false);
  });

  it("is nothing to clear rather than a failure when none exist", () => {
    expect(clearCfProfiles()).toEqual({ removed: 0 });
    expect(cfProfileCount()).toBe(0);
  });

  it("counts nothing when the directory has never been made", () => {
    process.env.DB_PATH = path.join(root, "nowhere", "bemby.db");
    expect(cfProfileCount()).toBe(0);
    expect(clearCfProfiles()).toEqual({ removed: 0 });
  });
});

// A profile is where the cookies live, so its name decides who shares a login with whom.
// The name is written by the operator, which is why so much of this is about what happens
// when it says something unexpected: the wrong answer silently shares a session between
// accounts, or splits one that was meant to be kept.
describe("cfProfileKey", () => {
  const PROXY = "http://user:secret@proxy.example:8080";
  const JOB = { jobId: 104, templateId: 48, tgId: 7 };

  it("is one profile per exit when nothing is configured", () => {
    expect(cfProfileKey(undefined)).toBe("direct");
    expect(cfProfileKey(PROXY)).toMatch(/^[0-9a-f]{12}$/);
    // The shipped default spelled out, which must mean the same as leaving it blank
    expect(cfProfileKey(PROXY, "{ip}")).toBe(cfProfileKey(PROXY));
  });

  it("never puts the proxy address in the name, credentials and all", () => {
    // The name becomes a directory on disk; the URL carries a password
    const key = cfProfileKey(PROXY, "{ip}");
    expect(key).not.toContain("secret");
    expect(key).not.toContain("proxy.example");
  });

  it("gives each job its own profile on the same exit", () => {
    // Two accounts going out through one exit must not share a cookie jar: the second login
    // would overwrite the first, and the site will not hand out another one
    const a = cfProfileKey(undefined, "{ip}-{jobId}", { jobId: 104 });
    const b = cfProfileKey(undefined, "{ip}-{jobId}", { jobId: 105 });
    expect(a).toBe("direct-104");
    expect(b).toBe("direct-105");
    expect(a).not.toBe(cfProfileKey(undefined, "{ip}"));
  });

  it("gives the same job the same profile every run, which is the point of it", () => {
    expect(cfProfileKey(PROXY, "{ip}-{jobId}", JOB)).toBe(cfProfileKey(PROXY, "{ip}-{jobId}", JOB));
  });

  it("keeps a job's profiles apart per exit, since a cookie is tied to where it came from", () => {
    expect(cfProfileKey(PROXY, "{ip}-{jobId}", JOB)).not.toBe(
      cfProfileKey(undefined, "{ip}-{jobId}", JOB),
    );
  });

  it("follows the account across its jobs, or the template across its accounts", () => {
    expect(cfProfileKey(undefined, "{tgId}", JOB)).toBe("7");
    // The interface calls it tgId; it is the account, so both spellings mean the same
    expect(cfProfileKey(undefined, "{accountId}", JOB)).toBe("7");
    expect(cfProfileKey(undefined, "{templateId}", JOB)).toBe("48");
  });

  it("takes free text, and text mixed with names", () => {
    expect(cfProfileKey(undefined, "user1")).toBe("user1");
    expect(cfProfileKey(undefined, "user1-{ip}-{jobId}", JOB)).toBe("user1-direct-104");
  });

  it("ignores case in a name, so {jobid} is not silently a different profile", () => {
    expect(cfProfileKey(undefined, "{JobId}", JOB)).toBe("104");
  });

  it("falls back to the exit when the name resolves to nothing", () => {
    // `{jobId}` outside a job, say. Falling back to the shared profile is the safe way to be
    // wrong: everything lands in one jar rather than in a directory called "-" for ever
    expect(cfProfileKey(undefined, "{jobId}")).toBe("direct");
    expect(cfProfileKey(PROXY, "{jobId}-{templateId}")).toBe(cfProfileKey(PROXY, "{ip}"));
    expect(cfProfileKey(undefined, "   ")).toBe("direct");
    expect(cfProfileKey(undefined, "")).toBe("direct");
  });

  it("drops a name it does not know rather than making it part of every profile", () => {
    expect(cfProfileKey(undefined, "{nonsense}-{jobId}", JOB)).toBe("nonsense-104");
  });

  it("leaves nothing in the name that a directory cannot hold", () => {
    expect(cfProfileKey(undefined, "../../etc")).toBe("etc");
    expect(cfProfileKey(undefined, "job 104/x")).toBe("job-104-x");
    expect(cfProfileKey(undefined, "a//b")).toBe("a-b");
    expect(cfProfileKey(undefined, "-lead-and-trail-")).toBe("lead-and-trail");
  });

  it("bounds the length, since the name ends up as a directory", () => {
    expect(cfProfileKey(undefined, "x".repeat(200)).length).toBe(64);
  });
});
