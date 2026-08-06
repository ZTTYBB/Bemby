// Managing browser profiles by hand: creating a name a job can target, deleting one, and
// carrying one to another instance as a .tar.gz. A profile is the only thing that makes a site
// treat the browser as a returning visitor, so losing one to a stray delete -- or to the LRU
// trimming meant for the pooled per-exit profiles -- costs a session that was set up by hand.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Readable, Writable } from "node:stream";
import os from "node:os";
import path from "node:path";

vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}));

import {
  createCfProfile,
  deleteCfProfiles,
  listCfProfiles,
  cfProfilesRoot,
} from "../jobs/cfBrowser";
import { exportCfProfiles, importCfProfiles } from "../jobs/cfProfileArchive";

const root = mkdtempSync(path.join(os.tmpdir(), "cfprofmanage-"));
const profiles = () => cfProfilesRoot();

beforeEach(() => {
  // dataDir() is read from DB_PATH on every call
  process.env.DB_PATH = path.join(root, "bemby.db");
  rmSync(profiles(), { recursive: true, force: true });
  mkdirSync(profiles(), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

/** A profile as a run leaves it: cookies and state worth keeping, caches worth dropping. */
function seedProfile(name: string, opts: { used?: boolean } = {}) {
  const dir = path.join(profiles(), name);
  mkdirSync(path.join(dir, "Default", "Local Storage", "leveldb"), { recursive: true });
  mkdirSync(path.join(dir, "Default", "Cache", "js"), { recursive: true });
  mkdirSync(path.join(dir, "Default", "Code Cache"), { recursive: true });
  writeFileSync(path.join(dir, "Default", "Cookies"), "cf_clearance=abc");
  writeFileSync(path.join(dir, "Default", "Local Storage", "leveldb", "000003.log"), "state");
  writeFileSync(path.join(dir, "Default", "Cache", "js", "big.bin"), "x".repeat(4096));
  writeFileSync(path.join(dir, "Default", "Code Cache", "c.bin"), "x".repeat(4096));
  writeFileSync(path.join(dir, "Local State"), "{}");
  if (opts.used) writeFileSync(path.join(dir, ".bemby-last-used"), "");
  return dir;
}

/** Collects a stream into one buffer, standing in for the HTTP response. */
function sink(): { stream: Writable; body: () => Buffer } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  return { stream, body: () => Buffer.concat(chunks) };
}

const namesOf = (list: Array<{ name: string }>) => list.map((p) => p.name).sort();

describe("createCfProfile", () => {
  it("reserves a name a job's profile field can target", () => {
    expect(createCfProfile("user1-direct")).toEqual({ ok: true });
    expect(existsSync(path.join(profiles(), "user1-direct"))).toBe(true);
    expect(namesOf(listCfProfiles())).toEqual(["user1-direct"]);
  });

  it("refuses a name that is not a directory name, rather than mangling it", () => {
    for (const bad of ["../escape", "has space", "a/b", "", "x".repeat(65)]) {
      const result = createCfProfile(bad);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("64");
    }
    expect(listCfProfiles()).toEqual([]);
  });

  it("refuses to create one twice, so an existing session is never clobbered", () => {
    createCfProfile("dup");
    writeFileSync(path.join(profiles(), "dup", "Local State"), "keep me");
    const again = createCfProfile("dup");
    expect(again.ok).toBe(false);
    expect(readFileSync(path.join(profiles(), "dup", "Local State"), "utf8")).toBe("keep me");
  });

  it("marks what it creates as manual, which is what exempts it from LRU trimming", () => {
    createCfProfile("kept");
    expect(listCfProfiles()[0]).toMatchObject({ name: "kept", managed: true, lastUsedAt: null });
  });
});

describe("listCfProfiles", () => {
  it("reports size and last use, and leaves throwaway directories out", () => {
    seedProfile("used-one", { used: true });
    mkdirSync(path.join(profiles(), "tmp-abc123"), { recursive: true });

    const list = listCfProfiles();
    expect(namesOf(list)).toEqual(["used-one"]);
    expect(list[0].sizeBytes).toBeGreaterThan(8000); // caches counted here: this is disk usage
    expect(list[0].lastUsedAt).toBeGreaterThan(0);
    expect(list[0].inUse).toBe(false);
  });
});

describe("deleteCfProfiles", () => {
  it("removes what it can and reports what it would not touch", () => {
    seedProfile("gone");
    const result = deleteCfProfiles(["gone", "never-existed", "../etc"]);
    expect(result.removed).toEqual(["gone"]);
    expect(result.refused.map((r) => r.name)).toEqual(["never-existed", "../etc"]);
    expect(existsSync(path.join(profiles(), "gone"))).toBe(false);
  });
});

describe("export / import round trip", () => {
  it("carries cookies and state across, without the caches", async () => {
    seedProfile("carry-me", { used: true });
    const out = sink();
    expect(await exportCfProfiles(["carry-me"], out.stream)).toEqual({ ok: true });
    const archive = out.body();
    expect(archive.length).toBeGreaterThan(0);

    // Wipe the instance, then import as if on another machine
    rmSync(path.join(profiles(), "carry-me"), { recursive: true, force: true });
    const result = await importCfProfiles(Readable.from(archive));
    expect(result).toMatchObject({ imported: ["carry-me"], skipped: [] });

    const dir = path.join(profiles(), "carry-me");
    expect(readFileSync(path.join(dir, "Default", "Cookies"), "utf8")).toBe("cf_clearance=abc");
    expect(existsSync(path.join(dir, "Default", "Local Storage", "leveldb", "000003.log"))).toBe(true);
    expect(existsSync(path.join(dir, "Local State"))).toBe(true);
    // The point of the exclusions
    expect(existsSync(path.join(dir, "Default", "Cache"))).toBe(false);
    expect(existsSync(path.join(dir, "Default", "Code Cache"))).toBe(false);
    // Imported by hand, so trimming leaves it alone
    expect(listCfProfiles()[0].managed).toBe(true);
  });

  it("exports several at once, each as its own profile", async () => {
    seedProfile("one");
    seedProfile("two");
    const out = sink();
    await exportCfProfiles(["one", "two"], out.stream);

    rmSync(profiles(), { recursive: true, force: true });
    const result = await importCfProfiles(Readable.from(out.body()));
    expect(result.imported.sort()).toEqual(["one", "two"]);
  });

  it("keeps an existing profile unless replacing is asked for", async () => {
    seedProfile("live");
    const out = sink();
    await exportCfProfiles(["live"], out.stream);
    const archive = out.body();

    writeFileSync(path.join(profiles(), "live", "Default", "Cookies"), "newer session");
    const skipped = await importCfProfiles(Readable.from(archive));
    expect(skipped.imported).toEqual([]);
    expect(skipped.skipped).toEqual([{ name: "live", reason: "Already exists" }]);
    expect(readFileSync(path.join(profiles(), "live", "Default", "Cookies"), "utf8")).toBe(
      "newer session",
    );

    const replaced = await importCfProfiles(Readable.from(archive), { replace: true });
    expect(replaced.imported).toEqual(["live"]);
    expect(readFileSync(path.join(profiles(), "live", "Default", "Cookies"), "utf8")).toBe(
      "cf_clearance=abc",
    );
  });

  it("refuses to export a profile that is not there", async () => {
    const out = sink();
    expect(await exportCfProfiles(["absent"], out.stream)).toEqual({
      ok: false,
      error: "No such profile",
    });
  });

  it("reports a body that is not an archive instead of half-importing it", async () => {
    const result = await importCfProfiles(Readable.from(Buffer.from("not a tarball at all")));
    expect(result.imported).toEqual([]);
    expect(result.error).toBeTruthy();
    // Nothing left behind: no staging directory, no partial profile
    expect(listCfProfiles()).toEqual([]);
  });
});
