// The development database is not the tests' to touch. Several fixtures clear whole tables
// (`DELETE FROM data_folders` among them), and for a while they were clearing them in the real
// database: a test file's own `process.env.DB_PATH = ...` runs after the hoisted import of
// db/database.ts, so the module had already fallen back to the working directory's file. This
// pins the guard that makes that impossible, since the mistake leaves no trace in a passing run.

import { describe, expect, it } from "vitest";
import path from "path";
import { db } from "../db/database";

describe("the database a test file is given", () => {
  it("is never the working directory's own file", () => {
    expect(path.resolve(db.name)).not.toBe(path.resolve(process.cwd(), "data/bemby.db"));
  });

  it("is a throwaway, so clearing a table clears only this run's rows", () => {
    expect(db.name).toContain("bemby-test-db-");
    db.prepare("INSERT INTO data_folders (name) VALUES ('isolation-probe')").run();
    expect(
      db.prepare("SELECT COUNT(*) c FROM data_folders").get(),
    ).toEqual({ c: 1 });
  });
});
