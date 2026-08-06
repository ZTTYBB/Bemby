import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { dataDir } from "./paths";

/**
 * x11vnc, installed into the data dir on demand.
 *
 * The manual browser needs it to serve its display, and it is not worth putting in every
 * image for a feature most installs never use -- the same reasoning as the solver browser
 * and the CJK fonts, which are also fetched into the data dir. Because that dir is a volume,
 * the install survives a restart and an upgrade.
 *
 * Installed rather than apt-get'd because the app runs as `node`, not root: apt would want
 * to write to /var and /usr, and even if it could, /usr is not part of the volume so an
 * upgrade would lose it. Instead apt is pointed at directories the app owns and asked only
 * what it *would* download; those .deb files are then unpacked into the data dir, and the
 * binary runs against them. apt resolves against this image's own installed set, so nothing
 * already present (libx11, libxext and the rest) is fetched twice.
 */

/** Where the unpacked packages live. */
export function vncRoot(): string {
  return path.join(dataDir(), "x11vnc");
}

const unpackedDir = (): string => path.join(vncRoot(), "root");
const debsDir = (): string => path.join(vncRoot(), "debs");
const aptDir = (): string => path.join(vncRoot(), "apt");

/** The binary this install provides, whether or not it is there yet. */
function installedBinary(): string {
  return path.join(unpackedDir(), "usr", "bin", "x11vnc");
}

/** Every directory in the unpacked tree holding a shared library. */
function libraryDirs(): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name.includes(".so"))) out.push(dir);
    for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
  };
  // Packages land in /lib/<triplet> or /usr/lib/<triplet> depending on their age, and a
  // merged-usr symlink does not exist in a tree that was only unpacked
  for (const base of ["lib", path.join("usr", "lib")]) {
    walk(path.join(unpackedDir(), base), 0);
  }
  return out;
}

export type VncStatus = {
  /** Whether the manual browser has an x11vnc to run at all. */
  available: boolean;
  /** Where it came from: the image, or the data-dir install. */
  source: "image" | "data-dir" | "none";
  /** Version string, when one could be read. */
  version?: string;
  /** Size of the data-dir install, for the settings page. */
  bytes?: number;
};

/** x11vnc from the image, if this image ships one. */
function systemBinary(): string | undefined {
  const found = spawnSync("sh", ["-c", "command -v x11vnc"], { encoding: "utf8" });
  const out = found.stdout?.trim();
  return found.status === 0 && out ? out : undefined;
}

/** How to run x11vnc: its path, and the environment it needs. Undefined when absent. */
export function vncCommand(): { bin: string; env: NodeJS.ProcessEnv } | undefined {
  if (existsSync(installedBinary())) {
    const libs = libraryDirs();
    return {
      bin: installedBinary(),
      env: {
        ...process.env,
        LD_LIBRARY_PATH: [...libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
      },
    };
  }
  const system = systemBinary();
  return system ? { bin: system, env: { ...process.env } } : undefined;
}

function dirBytes(dir: string): number {
  let total = 0;
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else
        try {
          total += statSync(full).size;
        } catch {
          /* vanished mid-walk */
        }
    }
  };
  walk(dir);
  return total;
}

export function vncStatus(): VncStatus {
  const cmd = vncCommand();
  if (!cmd) return { available: false, source: "none" };
  const fromData = cmd.bin.startsWith(vncRoot());
  const ran = spawnSync(cmd.bin, ["-version"], { encoding: "utf8", env: cmd.env, timeout: 5_000 });
  const version = `${ran.stdout ?? ""}${ran.stderr ?? ""}`.trim().split("\n")[0] || undefined;
  return {
    available: true,
    source: fromData ? "data-dir" : "image",
    version,
    ...(fromData ? { bytes: dirBytes(unpackedDir()) } : {}),
  };
}

/** apt, pointed at directories this process owns rather than the system's. */
function aptArgs(): string[] {
  const apt = aptDir();
  return [
    "-o", `Dir::State::Lists=${path.join(apt, "lists")}`,
    "-o", `Dir::Cache=${path.join(apt, "cache")}`,
    // Nothing here takes a lock in /var, which a non-root process cannot write
    "-o", "Debug::NoLocking=1",
    "-o", "Acquire::Retries=2",
  ];
}

function run(
  cmd: string,
  args: string[],
  onLine: (line: string) => void,
  timeoutMs = 300_000,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { env: process.env });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    const feed = (buf: Buffer): void => {
      for (const line of buf.toString().split("\n")) if (line.trim()) onLine(line.trim());
    };
    proc.stdout.on("data", feed);
    proc.stderr.on("data", feed);
    proc.once("error", (err) => {
      clearTimeout(timer);
      reject(
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(`${cmd} is not available in this image, so this cannot be installed here`)
          : err,
      );
    });
    proc.once("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

/** The .deb addresses apt would fetch: x11vnc, plus whatever this image is missing. */
async function resolveUris(onLine: (line: string) => void): Promise<string[]> {
  const out: string[] = [];
  const code = await run(
    "apt-get",
    [...aptArgs(), "install", "--print-uris", "--reinstall", "-y", "--no-install-recommends", "x11vnc"],
    (line) => {
      const m = /^'([^']+)'/.exec(line);
      if (m) out.push(m[1]);
      else onLine(line);
    },
  );
  if (!out.length) {
    throw new Error(
      code === 0
        ? "apt listed nothing to download for x11vnc, so it cannot be installed this way"
        : "apt could not work out what x11vnc needs. The package lists may have failed to update.",
    );
  }
  return out;
}

let installing = false;
const log: string[] = [];

export function vncInstallLog(): { installing: boolean; log: string[] } {
  return { installing, log: [...log] };
}

/**
 * Fetches x11vnc and its missing dependencies into the data dir.
 *
 * Returns once everything is unpacked and the binary answers `-version`: an install that
 * cannot run is worse than none, because the manual browser would fail later and further
 * from the cause.
 */
export async function installVnc(): Promise<VncStatus> {
  if (installing) throw new Error("An install is already running");
  installing = true;
  log.length = 0;
  const note = (line: string): void => {
    log.push(line);
    if (log.length > 200) log.shift();
  };

  try {
    mkdirSync(path.join(aptDir(), "lists", "partial"), { recursive: true });
    mkdirSync(path.join(aptDir(), "cache", "archives", "partial"), { recursive: true });
    mkdirSync(debsDir(), { recursive: true });

    note("Updating package lists...");
    await run("apt-get", [...aptArgs(), "update"], note);

    note("Working out what is needed...");
    const uris = await resolveUris(note);
    note(`${uris.length} package(s) to fetch`);

    for (const [i, uri] of uris.entries()) {
      const name = decodeURIComponent(uri.split("/").pop() ?? "package.deb");
      note(`(${i + 1}/${uris.length}) ${name}`);
      const res = await fetch(uri);
      if (!res.ok) throw new Error(`${name}: ${res.status} ${res.statusText}`);
      await writeFile(path.join(debsDir(), name), Buffer.from(await res.arrayBuffer()));
    }

    note("Unpacking...");
    // A half-written tree from an interrupted attempt would shadow the new one
    rmSync(unpackedDir(), { recursive: true, force: true });
    mkdirSync(unpackedDir(), { recursive: true });
    for (const deb of readdirSync(debsDir()).filter((f) => f.endsWith(".deb"))) {
      const code = await run("dpkg-deb", ["-x", path.join(debsDir(), deb), unpackedDir()], note);
      if (code !== 0) throw new Error(`${deb} could not be unpacked`);
    }
    // The .deb files are only needed while unpacking
    rmSync(debsDir(), { recursive: true, force: true });

    if (!existsSync(installedBinary())) {
      throw new Error("The packages unpacked, but no x11vnc binary came out of them");
    }

    const status = vncStatus();
    if (!status.version) {
      throw new Error(
        "x11vnc was installed but will not run here, most likely a library it needs is " +
          "missing from this image.",
      );
    }
    note(`Installed: ${status.version}`);
    // A marker of what this install was built against, for a future upgrade to look at
    writeFileSync(
      path.join(vncRoot(), "install.json"),
      JSON.stringify({ installedAt: new Date().toISOString(), version: status.version }, null, 2),
    );
    return status;
  } finally {
    installing = false;
  }
}

/** Removes the data-dir install, e.g. to fetch it again after an upgrade. */
export function removeVnc(): void {
  rmSync(vncRoot(), { recursive: true, force: true });
}

/** Kept for the settings page, which reports what a failed install said. */
export async function readInstallMarker(): Promise<string | undefined> {
  try {
    return await readFile(path.join(vncRoot(), "install.json"), "utf8");
  } catch {
    return undefined;
  }
}
