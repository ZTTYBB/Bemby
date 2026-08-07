// GET /manual-browser answers two callers with different claims on it: the viewer, which is
// someone looking at a screen and so must keep the session from idling out, and the jobs
// list, which polls in the background only to know which runs have a screen to offer. A poll
// of the second kind counting as the first would hold a hand-driven browser open for its
// whole hour cap with nobody at it.
vi.mock("../db/database", () => ({ db: { prepare: vi.fn() } }));
vi.mock("../jobs/runner", () => ({ resolveWebProxyUrl: vi.fn() }));
vi.mock("../jobs/runDisplays", () => ({ liveRunDisplays: vi.fn(() => RUNS) }));
vi.mock("../jobs/manualBrowser", () => ({
  currentManualSession: vi.fn(() => SESSION),
  touchManualSession: vi.fn(),
  gotoManualSession: vi.fn(),
  issueManualTicket: vi.fn(),
  jobById: vi.fn(),
  startManualSession: vi.fn(),
  stopManualSession: vi.fn(),
  watchRun: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import router from "../routes/manual-browser";
import { currentManualSession, touchManualSession } from "../jobs/manualBrowser";

const RUNS = [{ runId: "r1", jobId: 7, display: ":99", startedAt: 0 }];
let SESSION: { id: string } | undefined = { id: "s1" };

function statusHandler() {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === "/" && l.route.methods.get,
  );
  if (!layer) throw new Error("No GET / route registered");
  return layer.route.stack[0].handle as (req: any, res: any) => void;
}

function call(query: Record<string, string> = {}) {
  const res: any = { body: undefined, json: (b: unknown) => (res.body = b) };
  statusHandler()({ query }, res);
  return res.body as { session: unknown; runs: unknown[] };
}

beforeEach(() => {
  vi.clearAllMocks();
  SESSION = { id: "s1" };
  vi.mocked(currentManualSession).mockImplementation(() => SESSION as any);
});

describe("GET /manual-browser", () => {
  it("keeps the session alive for the viewer's own poll", () => {
    const body = call();
    expect(touchManualSession).toHaveBeenCalledWith("s1");
    expect(body.runs).toEqual(RUNS);
  });

  it("does not keep it alive for a poll that is only after the run list", () => {
    const body = call({ watching: "0" });
    expect(touchManualSession).not.toHaveBeenCalled();
    // The list is still answered in full -- that is what the caller came for
    expect(body.runs).toEqual(RUNS);
    expect(body.session).toEqual({ id: "s1" });
  });

  it("answers with no session open, without reaching for one to touch", () => {
    SESSION = undefined;
    const body = call();
    expect(touchManualSession).not.toHaveBeenCalled();
    expect(body.session).toBeNull();
  });
});
