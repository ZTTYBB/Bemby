// Where an exit comes out is remembered so it is not looked up every run, and that memory has
// to expire. `direct` names whatever host Bemby runs on, and a host moves country -- a new box,
// or a VPN brought up on it. Kept forever, a stale answer dresses every browser in the old
// country's clock and language, and nothing on the page says why.

import fs from "fs";
import os from "os";
import path from "path";

// The real database module reads DB_PATH at import time
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bemby-exit-geo-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/database";
import {
  CF_GEO_MAX_AGE_MS,
  cfExitGeo,
  clearCfExitGeo,
  rememberCfExitGeo,
} from "../tg/proxyProviders";

const GEO_KEY = "cf_exit_geo";

function writeRaw(value: unknown): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    GEO_KEY,
    JSON.stringify(value),
  );
}

beforeEach(() => {
  db.prepare("DELETE FROM settings WHERE key = ?").run(GEO_KEY);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("remembered exit locations", () => {
  it("keeps a fresh answer, stamped with when it was looked up", () => {
    rememberCfExitGeo("direct", { loc: "AU", tz: "Australia/Sydney", lang: "en-AU" });
    const known = cfExitGeo("direct");
    expect(known).toMatchObject({ loc: "AU", tz: "Australia/Sydney", lang: "en-AU" });
    expect(known?.at).toBeGreaterThan(0);
  });

  it("treats an answer past its age as unknown, so the next launch looks it up again", () => {
    writeRaw({
      direct: {
        loc: "CN",
        tz: "Asia/Shanghai",
        lang: "zh-CN",
        at: Date.now() - CF_GEO_MAX_AGE_MS - 1,
      },
    });
    expect(cfExitGeo("direct")).toBeUndefined();
  });

  it("re-checks an answer written before the stamp existed", () => {
    // Upgrade path: entries already on disk carry no `at`, and those are the oldest of all
    writeRaw({ direct: { loc: "CN", tz: "Asia/Shanghai", lang: "zh-CN" } });
    expect(cfExitGeo("direct")).toBeUndefined();
  });

  it("takes a new answer for an exit that has moved", () => {
    rememberCfExitGeo("direct", { loc: "CN", tz: "Asia/Shanghai", lang: "zh-CN" });
    rememberCfExitGeo("direct", { loc: "AU", tz: "Australia/Sydney", lang: "en-AU" });
    expect(cfExitGeo("direct")).toMatchObject({ loc: "AU", lang: "en-AU" });
  });

  it("forgets every exit on request, for a host that has just moved", () => {
    rememberCfExitGeo("direct", { loc: "AU" });
    rememberCfExitGeo("9d6f6eac491d", { loc: "SG" });
    expect(clearCfExitGeo()).toBe(2);
    expect(cfExitGeo("direct")).toBeUndefined();
    expect(cfExitGeo("9d6f6eac491d")).toBeUndefined();
  });

  it("keeps exits apart, and ignores one it has never seen", () => {
    rememberCfExitGeo("direct", { loc: "AU", lang: "en-AU" });
    expect(cfExitGeo("9d6f6eac491d")).toBeUndefined();
    expect(cfExitGeo("direct")?.lang).toBe("en-AU");
  });
});
