vi.mock("../db/database", () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
  },
}));
vi.mock("../scheduler", () => ({ refreshScheduler: vi.fn() }));

import { describe, it, expect, vi } from "vitest";
import { ALLOWED_KEYS } from "../routes/settings";

// ---------------------------------------------------------------------------
// ALLOWED_KEYS whitelist
// ---------------------------------------------------------------------------

describe("ALLOWED_KEYS", () => {
  it("contains all expected setting keys", () => {
    const expected = [
      "default_timezone",
      "default_max_retry",
      "check_daily_run",
      "default_ua",
      "default_play_duration",
      "default_device_name",
      "ai_model",
      "notify_tg_username",
      "notify_tg_events",
      "ua_presets",
    ];
    for (const key of expected) {
      expect(ALLOWED_KEYS).toContain(key);
    }
  });

  it("does not permit arbitrary keys", () => {
    expect(ALLOWED_KEYS).not.toContain("password");
    expect(ALLOWED_KEYS).not.toContain("session_string");
    expect(ALLOWED_KEYS).not.toContain("api_key");
    expect(ALLOWED_KEYS).not.toContain("jwt_secret");
  });

  it("has no duplicate entries", () => {
    expect(new Set(ALLOWED_KEYS).size).toBe(ALLOWED_KEYS.length);
  });
});
