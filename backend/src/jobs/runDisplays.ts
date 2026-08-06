import { startPrivateDisplay } from "./cfBrowser";
import type { CfRunState } from "./cloudflare";

/**
 * One X display per job run, so a run can be watched on its own.
 *
 * Every browser used to draw on one shared display, which is fine for a machine nobody looks
 * at but useless to attach a viewer to: it carries whatever else happens to be running at the
 * same moment. A display per run is what makes "show me *this* job" a question with an answer
 * -- and, because a viewer's pointer and keyboard reach the display it is attached to, what
 * makes taking over from a stuck run possible at all.
 *
 * Allocated when a run first opens a browser, not when it starts: most runs never need one.
 */

export type RunDisplay = {
  runId: string;
  jobId?: number;
  jobName?: string;
  display: string;
  startedAt: number;
};

type LiveRunDisplay = RunDisplay & { close: () => void };

const live = new Map<string, LiveRunDisplay>();

/** A cap, so a wedged run that never releases cannot exhaust the display numbers. */
const MAX_RUN_DISPLAYS = 24;

/** What a run is called, for the list a viewer picks from. */
const names = new Map<string, string>();

export function nameRun(runId: string, jobId: number | undefined, jobName: string): void {
  names.set(runId, jobName);
  if (jobId !== undefined) jobIds.set(runId, jobId);
}

const jobIds = new Map<string, number>();

/**
 * The display this run draws on, starting one the first time it is asked for.
 *
 * Returns undefined when none could be had, which is not a failure: the caller falls back to
 * the shared display, exactly as before. A run that cannot be watched is better than a run
 * that cannot start.
 */
export async function displayForRun(run: CfRunState): Promise<string | undefined> {
  const existing = live.get(run.runId);
  if (existing) return existing.display;
  if (live.size >= MAX_RUN_DISPLAYS) return undefined;

  const started = await startPrivateDisplay();
  if (!started) return undefined;

  live.set(run.runId, {
    runId: run.runId,
    jobId: jobIds.get(run.runId) ?? run.jobId,
    jobName: names.get(run.runId),
    display: started.display,
    startedAt: Date.now(),
    close: started.close,
  });
  return started.display;
}

/** Runs with a display up, for the panel to offer. */
export function liveRunDisplays(): RunDisplay[] {
  return [...live.values()]
    .map(({ close: _close, ...rest }) => ({ ...rest, jobName: names.get(rest.runId) ?? rest.jobName }))
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function runDisplay(runId: string): RunDisplay | undefined {
  return liveRunDisplays().find((r) => r.runId === runId);
}

/** Ends the run's display. Called when the run finishes, however it finished. */
export function releaseRunDisplay(runId: string): void {
  const found = live.get(runId);
  if (!found) return;
  live.delete(runId);
  names.delete(runId);
  jobIds.delete(runId);
  found.close();
}

/** Nothing should outlive the process: an X server left behind holds its display number. */
for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    for (const runId of [...live.keys()]) releaseRunDisplay(runId);
  });
}
