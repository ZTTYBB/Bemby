// A job on `{noProfile}` opens by hand like any other, on a throwaway profile of its own.
// It used to be refused before anything was even started, on the grounds that a login left in
// a throwaway profile would not survive the session -- true, and not the only reason to open a
// browser: watching what the page does, or working a challenge by hand once.
//
// Proven by where the attempt gets to. With no X display in a test environment the session
// cannot come up at all, so what matters is *which* wall it hits: the display, which is
// everything after the profile check, rather than the profile check itself.

vi.mock("../db/database", () => ({ db: { prepare: vi.fn() } }));
vi.mock("../jobs/runDisplays", () => ({ runDisplay: vi.fn() }));
vi.mock("../jobs/vncInstall", () => ({ vncCommand: vi.fn(() => undefined) }));
vi.mock("../jobs/cfBrowser", () => ({
  CF_NO_PROFILE_KEY: "(none)",
  cfProfileKey: vi.fn(() => PROFILE_KEY),
  configuredProfileId: vi.fn(() => "{ip}"),
  launchCfBrowser: vi.fn(),
  startPrivateDisplay: vi.fn(async () => undefined),
}));

import { beforeEach, describe, expect, it, vi } from "vitest";
import { startManualSession, stopManualSession } from "../jobs/manualBrowser";
import { launchCfBrowser, startPrivateDisplay } from "../jobs/cfBrowser";
import type { Job } from "../types";

let PROFILE_KEY = "(none)";

const JOB = {
  id: 108,
  name: "a web job",
  jobType: "custom",
  templateId: 52,
  config: JSON.stringify({ actions: [{ type: "open_url", url: "https://example.com/login" }] }),
} as unknown as Job;

beforeEach(async () => {
  await stopManualSession().catch(() => {});
  vi.clearAllMocks();
  vi.mocked(startPrivateDisplay).mockResolvedValue(undefined);
});

describe("opening a {noProfile} job by hand", () => {
  it("gets past the profile check and on to starting the session", async () => {
    PROFILE_KEY = "(none)";
    await expect(startManualSession({ job: JOB, accountId: 2 })).rejects.toThrow(/X display/);
    // Which is only reachable once the profile is settled, and it never asked for a name
    expect(startPrivateDisplay).toHaveBeenCalled();
  });

  it("no longer refuses outright over the profile name", async () => {
    PROFILE_KEY = "(none)";
    await expect(startManualSession({ job: JOB, accountId: 2 })).rejects.not.toThrow(
      /profile name/,
    );
  });

  it("treats a kept profile exactly as before", async () => {
    PROFILE_KEY = "9d6f6eac491d";
    await expect(startManualSession({ job: JOB, accountId: 2 })).rejects.toThrow(/X display/);
    expect(launchCfBrowser).not.toHaveBeenCalled();
  });
});
