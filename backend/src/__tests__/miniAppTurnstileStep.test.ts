import { describe, it, expect } from "vitest";
import { parseTurnstileStep } from "../jobs/cloudflare";

describe("parseTurnstileStep", () => {
  it("reads the step in any casing, with space around it", () => {
    expect(parseTurnstileStep("{turnstile}")).toBe(true);
    expect(parseTurnstileStep("  {Turnstile}  ")).toBe(true);
    expect(parseTurnstileStep("{ turnstile }")).toBe(true);
  });

  it("accepts the trailing ? some will write, since the step is forgiving anyway", () => {
    expect(parseTurnstileStep("{turnstile?}")).toBe(true);
  });

  it("leaves other steps alone", () => {
    expect(parseTurnstileStep("{aiBtn}")).toBe(false);
    expect(parseTurnstileStep("delay(2500)")).toBe(false);
    expect(parseTurnstileStep("css:.cf-turnstile")).toBe(false);
    // A control whose own label mentions Turnstile is a text step, not this one
    expect(parseTurnstileStep("turnstile")).toBe(false);
    expect(parseTurnstileStep(undefined)).toBe(false);
  });
});
