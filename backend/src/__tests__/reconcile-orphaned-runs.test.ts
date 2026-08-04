const { mockUpdateRun, mockPrepare } = vi.hoisted(() => {
  const mockUpdateRun = vi.fn().mockReturnValue({ changes: 0 });
  const mockPrepare = vi.fn().mockImplementation((sql: string) => {
    if (sql.startsWith("UPDATE job_logs")) return { run: mockUpdateRun };
    return {
      get: vi.fn().mockReturnValue(null),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    };
  });
  return { mockUpdateRun, mockPrepare };
});

vi.mock("../db/database", () => ({
  db: { prepare: mockPrepare },
  getDefaultTgApiCredentials: vi.fn().mockReturnValue(null),
}));
vi.mock("../jobs/runner", () => ({ runJob: vi.fn() }));
vi.mock("../jobs/cancellation", () => ({
  registerJob: vi.fn(),
  unregisterJob: vi.fn(),
  registerLiveDetail: vi.fn(),
  clearLiveDetail: vi.fn(),
}));
vi.mock("../jobs/notify", () => ({
  getNotifyConfig: vi.fn().mockReturnValue({ events: [], username: null }),
  notifyJobEvent: vi.fn(),
  sendTgNotify: vi.fn(),
  buildSuccessMessage: vi.fn(),
  buildFailureMessage: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcileOrphanedRuns } from "../scheduler";

describe("reconcileOrphanedRuns — stuck running logs (issue #18)", () => {
  beforeEach(() => {
    mockUpdateRun.mockClear();
    mockPrepare.mockClear();
  });

  it("marks leftover 'running' logs as failed", () => {
    reconcileOrphanedRuns();

    const sql = mockPrepare.mock.calls
      .map((c) => c[0] as string)
      .find((s) => s.startsWith("UPDATE job_logs"));
    expect(sql).toContain("status = 'failed'");
    expect(sql).toContain("WHERE status = 'running'");
    expect(mockUpdateRun).toHaveBeenCalledTimes(1);
  });
});
