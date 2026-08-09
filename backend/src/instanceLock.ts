/**
 * One backend per data dir.
 *
 * Almost everything the solver coordinates is held in this process and not in the database:
 * which CloakBrowser licence seats are leased, which browser profiles are open, which runs
 * are in flight. A second backend started against the same data dir shares none of that, so
 * the two hand out the same licence key at once (a free-plan key is one concurrent session,
 * and the loser is killed mid-run) and open the same profile directory at once, each
 * clearing the other's Chromium singleton locks. Both show up as a browser that vanishes
 * part-way through a job, which is a long way from the lock file that would have said so.
 *
 * The lock is advisory and self-healing: a process that was killed leaves its file behind,
 * and the next start takes it over once the recorded pid is gone.
 */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./jobs/paths";

const LOCK_FILE = "backend.lock";

type LockHolder = { pid: number; startedAt: string; port?: string };

function lockPath(): string {
  return path.join(dataDir(), LOCK_FILE);
}

function readHolder(): LockHolder | undefined {
  try {
    const holder = JSON.parse(readFileSync(lockPath(), "utf8")) as LockHolder;
    return typeof holder?.pid === "number" ? holder : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the recorded pid is still a backend rather than a number the kernel has since
 * handed to something else. Liveness alone would make a recycled pid look like a conflict
 * that no restart could clear, so on Linux the command line is checked too.
 */
function holderIsAlive(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (err: any) {
    // EPERM is a live process this user may not signal, which is the very case worth
    // catching: the stale backend here was started by root and the new one is not
    if (err?.code !== "EPERM") return false;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("node");
  } catch {
    // No procfs to check against, so liveness is all there is to go on
    return true;
  }
}

let held = false;

/**
 * Takes the lock for this process, or throws naming the process that already has it.
 * ALLOW_MULTIPLE_INSTANCES=1 skips it, for the operator who really does want two backends
 * on one volume.
 */
export function claimInstanceLock(): void {
  if (process.env.ALLOW_MULTIPLE_INSTANCES === "1") return;

  const existing = readHolder();
  if (existing && holderIsAlive(existing.pid)) {
    throw new Error(
      `Another Bemby backend (pid ${existing.pid}, started ${existing.startedAt}` +
        `${existing.port ? `, port ${existing.port}` : ""}) is already running against ` +
        `${dataDir()}. Two backends on one data dir hand out the same browser licence key ` +
        "and open the same browser profiles, which kills browsers mid-run. Stop that " +
        `process (kill ${existing.pid}), give this one its own DB_PATH, or set ` +
        "ALLOW_MULTIPLE_INSTANCES=1 if you are certain.",
    );
  }
  if (existing) {
    console.warn(
      `[instance] taking over the lock left by pid ${existing.pid}, which is no longer a backend`,
    );
  }

  const holder: LockHolder = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    port: process.env.PORT,
  };
  writeFileSync(lockPath(), JSON.stringify(holder));
  held = true;
  // Covers the ordinary exits; a SIGKILL leaves the file for the next start to take over
  process.once("exit", releaseInstanceLock);
}

export function releaseInstanceLock(): void {
  if (!held) return;
  held = false;
  // Only if it is still ours: a process that took over a stale lock must not clear it
  if (readHolder()?.pid !== process.pid) return;
  try {
    rmSync(lockPath(), { force: true });
  } catch {
    /* nothing useful to do while shutting down */
  }
}
