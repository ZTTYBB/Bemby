// The secrets store and its routes. Two things are worth holding down: a value can be
// written and used on this side, and there is no way at all to read one back out through
// the API -- which is the whole reason these do not live in settings.

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require("better-sqlite3");
  const memDb = new Database(":memory:");
  memDb.exec(`
    CREATE TABLE secrets (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return { memDb };
});

vi.mock("../db/database", () => ({ db: memDb }));

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  deleteSecret,
  fillSecrets,
  getSecret,
  isValidSecretKey,
  listSecrets,
  missingSecretRefs,
  setSecret,
} from "../db/secrets";
import secretsRouter from "../routes/secrets";

/** Pulls a route handler out of the Express router so it can be called directly. */
function routeHandler(method: string, path: string) {
  const layer = (secretsRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack[0].handle as (req: any, res: any) => any;
}

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

beforeEach(() => {
  memDb.exec("DELETE FROM secrets");
});

describe("the secrets store", () => {
  it("holds a value under a name and gives it back on this side", () => {
    setSecret("gmailAppPassword", "abcd efgh ijkl mnop");
    expect(getSecret("gmailAppPassword")).toBe("abcd efgh ijkl mnop");
  });

  it("replaces the value when the same name is written again", () => {
    setSecret("gmailAppPassword", "first");
    setSecret("gmailAppPassword", "second");
    expect(getSecret("gmailAppPassword")).toBe("second");
    expect(listSecrets()).toHaveLength(1);
  });

  it("lists names without values", () => {
    setSecret("a", "one");
    setSecret("b", "two");
    const listed = listSecrets();
    expect(listed.map((s) => s.key)).toEqual(["a", "b"]);
    expect(JSON.stringify(listed)).not.toContain("one");
  });

  it("returns null for a name nothing is stored under", () => {
    expect(getSecret("nothingHere")).toBeNull();
  });

  it("deletes, and says whether there was anything to delete", () => {
    setSecret("gone", "value");
    expect(deleteSecret("gone")).toBe(true);
    expect(deleteSecret("gone")).toBe(false);
    expect(getSecret("gone")).toBeNull();
  });

  it("only accepts names that can be written as {name}", () => {
    expect(isValidSecretKey("gmailAppPassword")).toBe(true);
    expect(isValidSecretKey("gmail_app_password2")).toBe(true);
    expect(isValidSecretKey("2fast")).toBe(false);
    expect(isValidSecretKey("has space")).toBe(false);
    expect(isValidSecretKey("has-dash")).toBe(false);
    expect(isValidSecretKey("")).toBe(false);
  });
});

describe("filling a field that names a secret", () => {
  it("swaps {name} for the stored value", () => {
    setSecret("gmailAppPassword", "abcd efgh");
    expect(fillSecrets("{gmailAppPassword}")).toBe("abcd efgh");
  });

  it("leaves a name nothing is stored under exactly as it stands", () => {
    expect(fillSecrets("{notSet}")).toBe("{notSet}");
  });

  it("names what is missing, so the step can say which one", () => {
    setSecret("known", "value");
    expect(missingSecretRefs("{known}")).toEqual([]);
    expect(missingSecretRefs("{known} {absent}")).toEqual(["absent"]);
  });
});

describe("the secrets routes", () => {
  it("lists names and when they were written, and no values", async () => {
    setSecret("gmailAppPassword", "abcd efgh");
    const res = fakeRes();
    await routeHandler("get", "/")({}, res);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].key).toBe("gmailAppPassword");
    expect(res.body[0].updatedAt).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain("abcd");
  });

  it("stores a value handed to it", async () => {
    const res = fakeRes();
    await routeHandler("put", "/:key")(
      { params: { key: "gmailAppPassword" }, body: { value: "abcd efgh" } },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(getSecret("gmailAppPassword")).toBe("abcd efgh");
  });

  it("refuses a name that could not be written as {name}", async () => {
    const res = fakeRes();
    await routeHandler("put", "/:key")(
      { params: { key: "not a name" }, body: { value: "x" } },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(listSecrets()).toEqual([]);
  });

  it("refuses an empty value rather than storing a blank credential", async () => {
    const res = fakeRes();
    await routeHandler("put", "/:key")({ params: { key: "blank" }, body: { value: "" } }, res);

    expect(res.statusCode).toBe(400);
    expect(getSecret("blank")).toBeNull();
  });

  it("deletes a stored name, and 404s on one that is not there", async () => {
    setSecret("gone", "value");
    const ok = fakeRes();
    await routeHandler("delete", "/:key")({ params: { key: "gone" } }, ok);
    expect(ok.statusCode).toBe(200);

    const missing = fakeRes();
    await routeHandler("delete", "/:key")({ params: { key: "gone" } }, missing);
    expect(missing.statusCode).toBe(404);
  });

  it("has no route that reads a value back", () => {
    const paths = (secretsRouter as any).stack
      .filter((l: any) => l.route)
      .map((l: any) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
    expect(paths.sort()).toEqual(["delete /:key", "get /", "put /:key"]);
  });
});
