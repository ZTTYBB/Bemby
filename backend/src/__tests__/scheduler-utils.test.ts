import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { toMinutes, pickNextRun } from "../scheduler-utils";

// ---------------------------------------------------------------------------
// toMinutes
// ---------------------------------------------------------------------------

describe("toMinutes", () => {
  it("converts 0000 to 0", () => expect(toMinutes(0)).toBe(0));
  it("converts 0930 to 570", () => expect(toMinutes(930)).toBe(570));
  it("converts 1200 to 720", () => expect(toMinutes(1200)).toBe(720));
  it("converts 1430 to 870", () => expect(toMinutes(1430)).toBe(870));
  it("converts 2359 to 1439", () => expect(toMinutes(2359)).toBe(1439));
});

// ---------------------------------------------------------------------------
// pickNextRun
// ---------------------------------------------------------------------------

describe("pickNextRun", () => {
  const TZ = "UTC";
  // Use a fixed Monday so date arithmetic is unambiguous
  const BASE_DATE = "2024-01-15"; // Monday

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setNow(timeUtc: string) {
    vi.setSystemTime(new Date(`${BASE_DATE}T${timeUtc}Z`));
  }

  // --- today's window ---

  it("picks within today's window when current time is before the window", () => {
    setNow("08:00:00"); // 08:00 — window 10:00–12:00 hasn't opened yet
    const result = pickNextRun(1000, 1200, TZ);
    const min = result.hour * 60 + result.minute;

    expect(result.toFormat("yyyy-MM-dd")).toBe(BASE_DATE);
    expect(min).toBeGreaterThanOrEqual(10 * 60);
    expect(min).toBeLessThan(12 * 60);
  });

  it("picks between now+1 min and window end when inside the window", () => {
    setNow("10:30:00"); // 10:30 — inside 10:00–12:00
    const result = pickNextRun(1000, 1200, TZ);
    const min = result.hour * 60 + result.minute;

    expect(result.toFormat("yyyy-MM-dd")).toBe(BASE_DATE);
    expect(min).toBeGreaterThanOrEqual(10 * 60 + 31); // at least now + 1 min
    expect(min).toBeLessThan(12 * 60);
  });

  it("always sets seconds and milliseconds to zero", () => {
    setNow("08:00:00");
    const result = pickNextRun(1000, 1200, TZ);

    expect(result.second).toBe(0);
    expect(result.millisecond).toBe(0);
  });

  // --- falls back to tomorrow ---

  it("picks tomorrow when past the window end", () => {
    setNow("13:00:00"); // 13:00 — window 10:00–12:00 has closed
    const result = pickNextRun(1000, 1200, TZ);
    const min = result.hour * 60 + result.minute;

    expect(result.toFormat("yyyy-MM-dd")).toBe("2024-01-16");
    expect(min).toBeGreaterThanOrEqual(10 * 60);
    expect(min).toBeLessThan(12 * 60);
  });

  it("picks tomorrow when less than 1 minute remains in the window", () => {
    setNow("11:59:00"); // 1 min before 12:00 end — remaining = 0
    const result = pickNextRun(1000, 1200, TZ);

    expect(result.toFormat("yyyy-MM-dd")).toBe("2024-01-16");
  });

  // --- daysAhead flag ---

  it("picks tomorrow even when before the window if daysAhead is 1", () => {
    setNow("08:00:00"); // before window — would normally pick today
    const result = pickNextRun(1000, 1200, TZ, 1);
    const min = result.hour * 60 + result.minute;

    expect(result.toFormat("yyyy-MM-dd")).toBe("2024-01-16");
    expect(min).toBeGreaterThanOrEqual(10 * 60);
    expect(min).toBeLessThan(12 * 60);
  });

  it("picks tomorrow even when inside the window if daysAhead is 1", () => {
    setNow("10:30:00"); // inside window
    const result = pickNextRun(1000, 1200, TZ, 1);

    expect(result.toFormat("yyyy-MM-dd")).toBe("2024-01-16");
  });

  // --- timezone handling ---

  it("respects the job timezone when choosing the window", () => {
    // 08:00 UTC = 16:00 CST (Asia/Shanghai, UTC+8)
    // Window 17:00–19:00 CST is ahead of current 16:00 CST → should pick today in CST
    setNow("08:00:00");
    const result = pickNextRun(1700, 1900, "Asia/Shanghai");
    const resultInTz = result.setZone("Asia/Shanghai");
    const min = resultInTz.hour * 60 + resultInTz.minute;

    expect(resultInTz.toFormat("yyyy-MM-dd")).toBe(BASE_DATE);
    expect(min).toBeGreaterThanOrEqual(17 * 60);
    expect(min).toBeLessThan(19 * 60);
  });

  it("rolls to the next calendar day in the correct timezone", () => {
    // 15:00 UTC = 23:00 CST — window 10:00–12:00 CST has already passed
    setNow("15:00:00");
    const result = pickNextRun(1000, 1200, "Asia/Shanghai");
    const resultInTz = result.setZone("Asia/Shanghai");
    const min = resultInTz.hour * 60 + resultInTz.minute;

    expect(resultInTz.toFormat("yyyy-MM-dd")).toBe("2024-01-16");
    expect(min).toBeGreaterThanOrEqual(10 * 60);
    expect(min).toBeLessThan(12 * 60);
  });
});
