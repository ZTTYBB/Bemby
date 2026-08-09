// Two backends on one data dir look like nothing in particular until a job runs: they hand
// out the same browser licence key and open the same browser profiles, and the browser dies
// part-way through with no sign of why. The lock is what turns that into a startup message.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { claimInstanceLock, releaseInstanceLock } from "../instanceLock";

let dir: string;
const previousDbPath = process.env.DB_PATH;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "bemby-lock-"));
  process.env.DB_PATH = path.join(dir, "bemby.db");
  delete process.env.ALLOW_MULTIPLE_INSTANCES;
});

afterEach(() => {
  releaseInstanceLock();
  rmSync(dir, { recursive: true, force: true });
  if (previousDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = previousDbPath;
});

const lockFile = () => path.join(dir, "backend.lock");

describe("the instance lock", () => {
  it("is taken when the data dir is free", () => {
    claimInstanceLock();
    expect(existsSync(lockFile())).toBe(true);
    releaseInstanceLock();
    expect(existsSync(lockFile())).toBe(false);
  });

  it("refuses a data dir another live backend holds, and says which", () => {
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
    try {
      writeFileSync(
        lockFile(),
        JSON.stringify({ pid: other.pid, startedAt: "2026-08-08T22:18:05.000Z" }),
      );
      expect(() => claimInstanceLock()).toThrow(new RegExp(`pid ${other.pid}`));
      expect(() => claimInstanceLock()).toThrow(/licence key/);
    } finally {
      other.kill();
    }
  });

  it("takes over a lock whose pid the kernel has given to something else", () => {
    // Alive, but not a backend: pid 1 is the container's init
    writeFileSync(lockFile(), JSON.stringify({ pid: 1, startedAt: "old" }));
    expect(() => claimInstanceLock()).not.toThrow();
  });

  it("takes over a lock whose process is gone", () => {
    // Above the pid ceiling, so it cannot be a running process
    writeFileSync(lockFile(), JSON.stringify({ pid: 0x7fffffff, startedAt: "old" }));
    expect(() => claimInstanceLock()).not.toThrow();
  });

  it("ignores a lock file that is not readable as one", () => {
    writeFileSync(lockFile(), "half a write");
    expect(() => claimInstanceLock()).not.toThrow();
  });

  it("stands aside when the operator has allowed several", () => {
    process.env.ALLOW_MULTIPLE_INSTANCES = "1";
    writeFileSync(lockFile(), JSON.stringify({ pid: 1, startedAt: "now" }));
    expect(() => claimInstanceLock()).not.toThrow();
  });
});
