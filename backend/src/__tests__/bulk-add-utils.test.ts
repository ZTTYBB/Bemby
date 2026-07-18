// vi.mock calls are hoisted before imports, preventing the DB from opening
vi.mock("../db/database", () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
  },
  getDefaultTgApiCredentials: vi.fn(),
}));

import { describe, it, expect, vi } from "vitest";
import { parseBulkAddInput, extractApiCredentials } from "../jobs/bulkAdd";

describe("parseBulkAddInput", () => {
  it("parses phone----apiUrl lines, trimming whitespace", () => {
    const input = [
      "+917507166497----https://example.com/getcode?id=80323dfc-9002",
      "  +918719968726----https://example.com/getcode?id=0eaa294a  ",
    ].join("\n");
    const { lines, errors } = parseBulkAddInput(input);
    expect(errors).toEqual([]);
    expect(lines).toEqual([
      {
        phoneNumber: "+917507166497",
        apiUrl: "https://example.com/getcode?id=80323dfc-9002",
      },
      {
        phoneNumber: "+918719968726",
        apiUrl: "https://example.com/getcode?id=0eaa294a",
      },
    ]);
  });

  it("skips blank lines", () => {
    const { lines } = parseBulkAddInput("\n\n+1----http://x\n\n");
    expect(lines).toHaveLength(1);
  });

  it("reports lines missing the separator", () => {
    const { lines, errors } = parseBulkAddInput("+1----http://x\nnosep");
    expect(lines).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Missing");
  });

  it("reports incomplete lines (empty phone or url)", () => {
    const { errors } = parseBulkAddInput("----http://x\n+1----");
    expect(errors).toHaveLength(2);
  });
});

describe("extractApiCredentials", () => {
  const html = `
    <input id="code" class="form-input" type="text" value="42344" readonly="" style="">
    <input class="form-input" type="text" value="2026-07-18 14:46:01" readonly="">
    <input id="pass2fa" class="form-input" type="text" value="bemby" readonly="" style="">
  `;

  it("extracts the code and 2FA password from the page inputs", () => {
    expect(extractApiCredentials(html)).toEqual({
      code: "42344",
      pass2fa: "bemby",
    });
  });

  it("returns empty strings when the inputs are absent", () => {
    expect(extractApiCredentials("<div>no inputs here</div>")).toEqual({
      code: "",
      pass2fa: "",
    });
  });

  it("handles an empty (not-yet-ready) code value", () => {
    const empty = `<input id="code" value="" readonly><input id="pass2fa" value="bemby">`;
    expect(extractApiCredentials(empty)).toEqual({ code: "", pass2fa: "bemby" });
  });
});
