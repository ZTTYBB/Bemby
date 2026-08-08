// The deployment-level gate on the data store: DATA_MANAGEMENT, the same shape as
// BULK_ACCOUNT_MANAGEMENT. Off by default, and off means the feature is not there to be found
// -- the stored Settings toggle counts for nothing, so a panel that never enabled it cannot be
// pointed at the store by a job, a placeholder or a stale page either.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/database";
import {
  dataStoreOffReason,
  fillDataRefs,
  isDataManagementEnabled,
  isDataStoreEnabled,
  writeDataValue,
} from "../db/dataStore";

function setToggle(on: boolean): void {
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('data_store_enabled', ?)",
  ).run(String(on));
}

beforeEach(() => {
  delete process.env.DATA_MANAGEMENT;
  db.prepare("DELETE FROM data_records").run();
  db.prepare("DELETE FROM data_folders").run();
  setToggle(true);
});

afterEach(() => {
  delete process.env.DATA_MANAGEMENT;
});

describe("isDataManagementEnabled", () => {
  it("is off when the variable is absent, so a plain deployment has no data store", () => {
    expect(isDataManagementEnabled()).toBe(false);
  });

  it("takes 1 and true, however they are cased or padded", () => {
    for (const v of ["1", "true", "TRUE", " true "]) {
      process.env.DATA_MANAGEMENT = v;
      expect(isDataManagementEnabled()).toBe(true);
    }
  });

  it("ignores anything else, including a value that only looks affirmative", () => {
    for (const v of ["0", "false", "yes", "on", ""]) {
      process.env.DATA_MANAGEMENT = v;
      expect(isDataManagementEnabled()).toBe(false);
    }
  });
});

describe("isDataStoreEnabled", () => {
  it("stays off with the toggle on but the deployment not offering the feature", () => {
    setToggle(true);
    expect(isDataStoreEnabled()).toBe(false);
  });

  it("follows the toggle once the deployment offers it", () => {
    process.env.DATA_MANAGEMENT = "1";
    setToggle(true);
    expect(isDataStoreEnabled()).toBe(true);
    setToggle(false);
    expect(isDataStoreEnabled()).toBe(false);
  });
});

describe("dataStoreOffReason", () => {
  it("names the env var when that is the switch to change", () => {
    expect(dataStoreOffReason()).toContain("DATA_MANAGEMENT");
  });

  it("names Settings when the deployment does offer the feature", () => {
    process.env.DATA_MANAGEMENT = "1";
    expect(dataStoreOffReason()).toBe("Data is turned off in Settings");
  });
});

describe("{data...} placeholders", () => {
  it("are left as they stand when the feature is not offered, stored value or not", () => {
    process.env.DATA_MANAGEMENT = "1";
    writeDataValue("example", "email", "password", "hunter2");
    expect(fillDataRefs("pw: {data.example.email.password}")).toBe("pw: hunter2");

    delete process.env.DATA_MANAGEMENT;
    expect(fillDataRefs("pw: {data.example.email.password}")).toBe(
      "pw: {data.example.email.password}",
    );
  });
});
