// A Turnstile token is only proof of anything when the site asked for it. Cloudflare's own
// interstitial fills the same field in and still refuses the address, which is how a
// blocked site came to be logged as solved -- and its page steps then spent their whole
// timeout waiting for a login form that was never going to render.
import { describe, it, expect } from "vitest";
import { turnstilePassed } from "../jobs/cloudflare";

describe("turnstilePassed", () => {
  it("accepts a token from a widget on the site's own page", () => {
    expect(turnstilePassed("0.abc123", false)).toBe(true);
  });

  it("rejects a token issued by a full-page interstitial", () => {
    expect(turnstilePassed("0.abc123", true)).toBe(false);
  });

  it("is not satisfied by an empty token either way", () => {
    expect(turnstilePassed("", false)).toBe(false);
    expect(turnstilePassed("", true)).toBe(false);
  });
});
