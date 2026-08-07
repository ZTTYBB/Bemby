// A signed Mini App URL names one account, but that is only what the app sees on a first
// visit: most keep a token of their own afterwards and read that instead. In a profile shared
// by several accounts every run then lands on whoever signed in first. Clearing the app's own
// state before the page loads is what stops that -- without taking the exit's Cloudflare
// clearance, which is the whole reason a profile is shared in the first place.

import { describe, it, expect } from "vitest";
import { miniAppCookiesToDrop } from "../jobs/cloudflare";

const cookie = (name: string, domain: string) => ({ name, domain });

describe("miniAppCookiesToDrop", () => {
  const HOST = "miniapp.ftp2.eu.org";

  it("drops the app's own session cookie", () => {
    const jar = [cookie("session", HOST), cookie("token", `.${HOST}`)];
    expect(miniAppCookiesToDrop(HOST, jar).map((c) => c.name)).toEqual(["session", "token"]);
  });

  it("keeps what Cloudflare issued, which belongs to the exit and not to the account", () => {
    const jar = [
      cookie("cf_clearance", HOST),
      cookie("__cf_bm", `.${HOST}`),
      cookie("session", HOST),
    ];
    expect(miniAppCookiesToDrop(HOST, jar).map((c) => c.name)).toEqual(["session"]);
  });

  it("leaves every other site in the profile alone", () => {
    const jar = [cookie("session", "other.example.com"), cookie("session", HOST)];
    expect(miniAppCookiesToDrop(HOST, jar)).toEqual([cookie("session", HOST)]);
  });

  it("takes a parent-domain cookie the app would be sent, and no sibling's", () => {
    // A cookie on .ftp2.eu.org rides along on every request to the app, so leaving it would
    // leave the session behind; one on a sibling host never reaches the app at all
    const jar = [cookie("uid", ".ftp2.eu.org"), cookie("uid", "other.ftp2.eu.org")];
    expect(miniAppCookiesToDrop(HOST, jar)).toEqual([cookie("uid", ".ftp2.eu.org")]);
  });

  it("is not fooled by a domain that merely ends the same way", () => {
    expect(miniAppCookiesToDrop(HOST, [cookie("uid", "notftp2.eu.org")])).toEqual([]);
  });

  it("ignores case, since a jar may spell the domain either way", () => {
    expect(miniAppCookiesToDrop(HOST, [cookie("uid", HOST.toUpperCase())])).toHaveLength(1);
  });

  it("has nothing to do on a first visit", () => {
    expect(miniAppCookiesToDrop(HOST, [])).toEqual([]);
  });
});
