// A free CloakBrowser key allows one concurrent session, so the pool has to hand each
// running browser a different key and never the same one twice -- and it must never let a
// raw key back out to the client.
import { describe, it, expect, beforeEach, vi } from "vitest";

const rows = new Map<string, string>();

vi.mock("../db/database", () => ({
  db: {
    prepare: (sql: string) => ({
      get: (key: string) =>
        sql.includes("SELECT") && rows.has(key) ? { value: rows.get(key) } : undefined,
      run: (key: string, value: string) => rows.set(key, value),
      all: () => [],
    }),
  },
}));

import {
  CF_KEYS_SETTING,
  cfLicenseKeys,
  cfLicenseKeysForClient,
  cfLicenseUsage,
  leaseCfLicenseKey,
  maskKey,
  saveCfLicenseKeys,
} from "../jobs/cfLicense";

beforeEach(() => {
  rows.clear();
  delete process.env.CLOAKBROWSER_LICENSE_KEY;
  saveCfLicenseKeys([]);
});

describe("stored keys", () => {
  it("keeps what was saved and drops entries with no key", () => {
    saveCfLicenseKeys([
      { label: "acct-a", key: "cb_aaaaaaaaaaaa" },
      { label: "blank", key: "  " },
    ]);
    expect(cfLicenseKeys()).toEqual([{ label: "acct-a", key: "cb_aaaaaaaaaaaa" }]);
  });

  it("never sends a raw key to the client", () => {
    saveCfLicenseKeys([{ label: "acct-a", key: "cb_aaaaaaaaaaaa" }]);
    const view = cfLicenseKeysForClient();
    expect(view).toEqual([{ label: "acct-a", masked: maskKey("cb_aaaaaaaaaaaa") }]);
    expect(JSON.stringify(view)).not.toContain("cb_aaaaaaaaaaaa");
  });

  // The client only ever holds masked values, so a save that echoes one back has to keep
  // the stored key rather than replacing it with the mask.
  it("keeps the stored key when the client sends the masked value back", () => {
    saveCfLicenseKeys([{ label: "acct-a", key: "cb_aaaaaaaaaaaa" }]);
    saveCfLicenseKeys([{ label: "renamed", key: maskKey("cb_aaaaaaaaaaaa") }]);
    expect(cfLicenseKeys()).toEqual([{ label: "renamed", key: "cb_aaaaaaaaaaaa" }]);
  });

  it("drops a duplicate of a key already in the list", () => {
    saveCfLicenseKeys([
      { label: "a", key: "cb_aaaaaaaaaaaa" },
      { label: "a again", key: "cb_aaaaaaaaaaaa" },
    ]);
    expect(cfLicenseKeys()).toHaveLength(1);
  });

  it("stores under the documented settings key", () => {
    saveCfLicenseKeys([{ label: "a", key: "cb_aaaaaaaaaaaa" }]);
    expect(rows.get(CF_KEYS_SETTING)).toContain("cb_aaaaaaaaaaaa");
  });
});

describe("leasing", () => {
  beforeEach(() => {
    saveCfLicenseKeys([
      { label: "a", key: "cb_aaaaaaaaaaaa" },
      { label: "b", key: "cb_bbbbbbbbbbbb" },
    ]);
  });

  it("hands two concurrent browsers different keys", () => {
    const first = leaseCfLicenseKey();
    const second = leaseCfLicenseKey();
    expect(first.key).toBeDefined();
    expect(second.key).toBeDefined();
    expect(first.key).not.toBe(second.key);
    expect(cfLicenseUsage()).toEqual({ total: 2, inUse: 2 });
  });

  // Doubling up would put two sessions on one seat, which is what the free tier refuses.
  // Running the older build is the lesser evil, so the third browser gets no key.
  it("gives no key out once every seat is taken", () => {
    leaseCfLicenseKey();
    leaseCfLicenseKey();
    expect(leaseCfLicenseKey().key).toBeUndefined();
  });

  it("offers a key again once its browser has closed", () => {
    const first = leaseCfLicenseKey();
    leaseCfLicenseKey();
    first.release();
    expect(leaseCfLicenseKey().key).toBe(first.key);
  });

  it("lets the environment override the stored keys", () => {
    process.env.CLOAKBROWSER_LICENSE_KEY = "cb_from_env";
    expect(leaseCfLicenseKey().key).toBe("cb_from_env");
    // and takes no seat, so it is not exhausted by concurrent jobs
    expect(leaseCfLicenseKey().key).toBe("cb_from_env");
  });

  it("reports no key at all when none is configured", () => {
    saveCfLicenseKeys([]);
    expect(leaseCfLicenseKey().key).toBeUndefined();
    expect(cfLicenseUsage()).toEqual({ total: 0, inUse: 0 });
  });
});
