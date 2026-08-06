// x11vnc unpacked into the data dir, rather than installed with apt: the app runs as `node`,
// and /usr is not part of the volume anyway, so an upgrade would lose it.
//
// The part worth guarding is where the libraries end up. Packages unpack to /lib/<triplet>
// or /usr/lib/<triplet> depending on their age, and a tree that was only unpacked has no
// merged-usr symlink joining them -- miss one and the binary dies with "cannot open shared
// object file", which is what happened the first time this was tried by hand.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}));

import { vncCommand, vncRoot, vncStatus } from "../jobs/vncInstall";

const root = mkdtempSync(path.join(os.tmpdir(), "vncinstall-"));

beforeEach(() => {
  // dataDir() is read from DB_PATH on every call, so each test can point it somewhere new
  process.env.DB_PATH = path.join(root, "bemby.db");
  rmSync(path.join(root, "x11vnc"), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

/** An unpacked tree like dpkg-deb leaves behind, with libraries where packages put them. */
function fakeInstall(libDirs: string[]): string {
  const unpacked = path.join(vncRoot(), "root");
  mkdirSync(path.join(unpacked, "usr", "bin"), { recursive: true });
  // A script rather than a binary: it only has to be runnable and answer -version
  const bin = path.join(unpacked, "usr", "bin", "x11vnc");
  writeFileSync(bin, "#!/bin/sh\necho 'x11vnc: 0.9.16 lastmod: 2019-01-05'\n");
  chmodSync(bin, 0o755);
  for (const dir of libDirs) {
    const full = path.join(unpacked, dir);
    mkdirSync(full, { recursive: true });
    writeFileSync(path.join(full, "libvncserver.so.1"), "");
  }
  return unpacked;
}

describe("vncCommand", () => {
  it("has nothing to offer before anything is installed", () => {
    // Nothing in the data dir, and the test host has no x11vnc of its own
    expect(vncStatus().available).toBe(vncCommand() !== undefined);
  });

  it("finds the unpacked binary and runs it", () => {
    fakeInstall(["usr/lib/x86_64-linux-gnu"]);
    const cmd = vncCommand();
    expect(cmd?.bin).toBe(path.join(vncRoot(), "root", "usr", "bin", "x11vnc"));

    const status = vncStatus();
    expect(status.available).toBe(true);
    expect(status.source).toBe("data-dir");
    expect(status.version).toContain("0.9.16");
    expect(status.bytes).toBeGreaterThan(0);
  });

  it("puts /lib/<triplet> on the library path as well as /usr/lib/<triplet>", () => {
    // liblzo2 lands in the first, libvncserver in the second; missing either is a binary
    // that will not start
    fakeInstall(["lib/x86_64-linux-gnu", "usr/lib/x86_64-linux-gnu"]);
    const dirs = (vncCommand()?.env.LD_LIBRARY_PATH ?? "").split(":");
    expect(dirs).toContain(path.join(vncRoot(), "root", "lib", "x86_64-linux-gnu"));
    expect(dirs).toContain(path.join(vncRoot(), "root", "usr", "lib", "x86_64-linux-gnu"));
  });

  it("names the directory whatever the triplet is, rather than assuming one", () => {
    // The image is built for more than one architecture
    fakeInstall(["usr/lib/aarch64-linux-gnu"]);
    expect(vncCommand()?.env.LD_LIBRARY_PATH).toContain("aarch64-linux-gnu");
  });

  it("keeps a library path the environment already had", () => {
    const had = process.env.LD_LIBRARY_PATH;
    process.env.LD_LIBRARY_PATH = "/opt/somewhere/lib";
    try {
      fakeInstall(["usr/lib/x86_64-linux-gnu"]);
      expect(vncCommand()?.env.LD_LIBRARY_PATH).toContain("/opt/somewhere/lib");
    } finally {
      if (had === undefined) delete process.env.LD_LIBRARY_PATH;
      else process.env.LD_LIBRARY_PATH = had;
    }
  });

  it("ignores a tree with no binary in it, which is what a failed unpack leaves", () => {
    mkdirSync(path.join(vncRoot(), "root", "usr", "lib"), { recursive: true });
    const cmd = vncCommand();
    // Falls through to the image's own x11vnc, if this host has one
    expect(cmd?.bin.startsWith(vncRoot())).not.toBe(true);
  });
});
