vi.mock("../db/database", () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
  },
}));

import { describe, it, expect, vi } from "vitest";
import {
  normaliseNotifyTarget,
  buildFailureMessage,
  buildSuccessMessage,
} from "../jobs/notify";

// ---------------------------------------------------------------------------
// normaliseNotifyTarget
// ---------------------------------------------------------------------------

describe("normaliseNotifyTarget", () => {
  it("adds @ to a bare username", () => {
    expect(normaliseNotifyTarget("myuser")).toBe("@myuser");
  });

  it("keeps a single @ on an already-prefixed username", () => {
    expect(normaliseNotifyTarget("@myuser")).toBe("@myuser");
  });

  it("converts a full t.me URL", () => {
    expect(normaliseNotifyTarget("https://t.me/myuser")).toBe("@myuser");
  });

  it("converts a t.me URL without the scheme", () => {
    expect(normaliseNotifyTarget("t.me/myuser")).toBe("@myuser");
  });

  it("converts an http t.me URL", () => {
    expect(normaliseNotifyTarget("http://t.me/myuser")).toBe("@myuser");
  });

  it("trims surrounding whitespace before normalising", () => {
    expect(normaliseNotifyTarget("  @myuser  ")).toBe("@myuser");
  });
});

// ---------------------------------------------------------------------------
// buildFailureMessage
// ---------------------------------------------------------------------------

describe("buildFailureMessage", () => {
  it("includes the job name, type, and error message", () => {
    const msg = buildFailureMessage("Daily Checkin", "checkin", "Timeout");
    expect(msg).toContain("Daily Checkin");
    expect(msg).toContain("checkin");
    expect(msg).toContain("Timeout");
  });

  it("has the correct format", () => {
    const msg = buildFailureMessage("Job A", "custom", "Something went wrong");
    expect(msg).toBe(
      "❌ Bemby job failed\n\nJob: Job A\nType: custom\nError: Something went wrong",
    );
  });
});

// ---------------------------------------------------------------------------
// buildSuccessMessage
// ---------------------------------------------------------------------------

describe("buildSuccessMessage", () => {
  it("includes the job name and type", () => {
    const msg = buildSuccessMessage("Daily Checkin", "checkin");
    expect(msg).toContain("Daily Checkin");
    expect(msg).toContain("checkin");
  });

  it("has the correct format", () => {
    const msg = buildSuccessMessage("Job A", "custom");
    expect(msg).toBe("✅ Bemby job succeeded\n\nJob: Job A\nType: custom");
  });
});
