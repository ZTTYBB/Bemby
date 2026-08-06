// An account's proxy is its Telegram exit, and MTProto only speaks SOCKS. Webshare (and any
// downloaded list without an explicit scheme) hands out http:// proxies, which parseTgProxy
// drops -- so before this guard, assigning one left the account connecting direct with nothing
// said about it, looking like a proxy that quietly did not work.

import Database from "better-sqlite3";
import http from "http";
import express from "express";

let testDb!: InstanceType<typeof Database>;

vi.mock("../db/database", () => ({
  get db() {
    return testDb;
  },
  getDefaultTgApiCredentials: () => null,
}));
vi.mock("../scheduler", () => ({ refreshScheduler: vi.fn() }));
vi.mock("../auth/tgAuth", () => ({
  requestCode: vi.fn(),
  submitCode: vi.fn(),
  submitPassword: vi.fn(),
  checkAccountStatus: vi.fn(),
  resendCodeAsSms: vi.fn(),
  updateTwoFa: vi.fn(),
  getSessions: vi.fn(),
  terminateSession: vi.fn(),
  terminateOtherSessions: vi.fn(),
}));
vi.mock("../jobs/checkin", () => ({ checkSpamStatus: vi.fn() }));
// Faithful stand-in for the real parser (covered on its own in proxy.test.ts): SOCKS in,
// everything else rejected. The route's rule is "whatever Telegram cannot use is refused".
vi.mock("../jobs/runner", () => ({
  parseTgProxy: (url?: string) => {
    if (!url) return undefined;
    const proto = url.slice(0, url.indexOf(":"));
    return proto === "socks5" || proto === "socks4" || proto === "socks"
      ? { ip: "host", port: 1080, socksType: 5 }
      : undefined;
  },
}));
vi.mock("../tg/liveClient", () => ({
  isAuthError: vi.fn(),
  markSessionExpired: vi.fn(),
}));

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tg_accounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    phone_number   TEXT    NOT NULL DEFAULT '',
    api_id         INTEGER NOT NULL DEFAULT 0,
    api_hash       TEXT    NOT NULL DEFAULT '',
    session_string TEXT,
    auth_status    TEXT    NOT NULL DEFAULT 'unauthenticated',
    proxy_id       TEXT,
    disabled       INTEGER NOT NULL DEFAULT 0,
    app_client_id  TEXT,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    notes          TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`;

const PROXIES = [
  { id: "sock", name: "Manual SOCKS", url: "socks5://user:pass@1.2.3.4:1080" },
  { id: "web", name: "Webshare GB London", url: "http://user:pass@5.6.7.8:80" },
];

let server: http.Server;
let baseUrl: string;

const post = (body: unknown) =>
  fetch(`${baseUrl}/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const put = (id: number, body: unknown) =>
  fetch(`${baseUrl}/accounts/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const newAccount = (extra: Record<string, unknown> = {}) => ({
  name: "Acct",
  phoneNumber: "+61400000000",
  apiId: "12345",
  apiHash: "abcdef",
  ...extra,
});

const proxyIdOf = (id: number) =>
  (
    testDb.prepare("SELECT proxy_id FROM tg_accounts WHERE id = ?").get(id) as {
      proxy_id: string | null;
    }
  ).proxy_id;

beforeAll(async () => {
  testDb = new Database(":memory:");
  testDb.exec(SCHEMA);

  const { default: accountsRouter } = await import("../routes/accounts");
  const app = express();
  app.use(express.json());
  app.use("/accounts", accountsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  testDb.exec("DELETE FROM tg_accounts; DELETE FROM settings;");
  testDb
    .prepare("INSERT INTO settings (key, value) VALUES ('proxies', ?)")
    .run(JSON.stringify(PROXIES));
});

describe("account proxy scheme guard", () => {
  it("refuses to create an account behind an HTTP proxy, naming the scheme", async () => {
    const res = await post(newAccount({ proxyId: "web" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("http://");
    expect(body.error).toContain("socks5://");
    expect(
      testDb.prepare("SELECT COUNT(*) AS c FROM tg_accounts").get(),
    ).toEqual({ c: 0 });
  });

  it("creates one behind a SOCKS proxy, and with no proxy at all", async () => {
    expect((await post(newAccount({ proxyId: "sock" }))).status).toBe(201);
    expect((await post(newAccount({ phoneNumber: "+61400000001" }))).status).toBe(201);
  });

  it("refuses to move an existing account onto an HTTP proxy", async () => {
    const created = await (await post(newAccount({ proxyId: "sock" }))).json();
    const res = await put(created.id, { proxyId: "web" });
    expect(res.status).toBe(400);
    expect(proxyIdOf(created.id)).toBe("sock");
  });

  it("still allows other edits on an account already carrying an HTTP proxy", async () => {
    // Assigned before the guard existed (or imported), so editing must not be a dead end
    const created = await (await post(newAccount())).json();
    testDb
      .prepare("UPDATE tg_accounts SET proxy_id = 'web' WHERE id = ?")
      .run(created.id);

    const res = await put(created.id, { name: "Renamed", proxyId: "web" });
    expect(res.status).toBe(200);
    expect(proxyIdOf(created.id)).toBe("web");

    // ...and clearing it, or moving to SOCKS, is accepted
    expect((await put(created.id, { proxyId: "" })).status).toBe(200);
    expect(proxyIdOf(created.id)).toBeNull();
  });

  it("says nothing about a proxy id that is not in the list", async () => {
    const res = await post(newAccount({ proxyId: "deleted-entry" }));
    expect(res.status).toBe(201);
  });
});
