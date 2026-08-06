// Moving a browser profile between instances. A profile is what makes a site treat this
// machine as a returning visitor -- its cookies, its cf_clearance, whatever it is signed in
// to -- so being able to carry one to another Bemby (or keep a copy before clearing them all)
// is worth more than rebuilding the session by hand.
//
// Archives are plain .tar.gz produced by the system tar, which the Debian base image ships.
// Caches are left out: they are hundreds of megabytes, Chromium rebuilds them on first launch,
// and nothing about the identity of the profile lives there.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  CF_PROFILE_NAME_RE,
  cfProfileInUse,
  cfProfilesRoot,
  markCfProfileManaged,
} from "./cfBrowser";

/** Directories regenerated on launch, which would otherwise dominate the archive. */
export const CF_PROFILE_CACHE_DIRS = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "ShaderCache",
  "GrShaderCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "component_crx_cache",
  "extensions_crx_cache",
  "Service Worker",
];

/** tar arguments that drop the cache directories wherever they sit in the tree. */
export function cacheExcludeArgs(): string[] {
  return CF_PROFILE_CACHE_DIRS.flatMap((dir) => [
    `--exclude=${dir}`,
    `--exclude=*/${dir}`,
    `--exclude=*/${dir}/*`,
  ]);
}

type ExportResult = { ok: true } | { ok: false; error: string };

/**
 * Streams the named profiles into `out` as one .tar.gz, each as a top-level directory.
 * Names are validated by the caller; anything not on disk is skipped by tar itself.
 */
export function exportCfProfiles(names: string[], out: Writable): Promise<ExportResult> {
  const root = cfProfilesRoot();
  const present = names.filter((n) => CF_PROFILE_NAME_RE.test(n) && existsSync(path.join(root, n)));
  if (!present.length) return Promise.resolve({ ok: false, error: "No such profile" });

  return new Promise((resolve) => {
    // A profile a browser is writing to right now can be read, but the copy may catch a
    // half-written cookie store, so the caller warns about that rather than this refusing.
    const tar = spawn(
      "tar",
      ["-czf", "-", "-C", root, ...cacheExcludeArgs(), "--", ...present],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    tar.stderr.on("data", (chunk) => {
      stderr += String(chunk).slice(0, 2_000);
    });
    tar.stdout.pipe(out);
    tar.on("error", (err) => resolve({ ok: false, error: err.message }));
    tar.on("close", (code) =>
      // 1 is "some files changed while being read", which is expected on a live profile
      resolve(code === 0 || code === 1 ? { ok: true } : { ok: false, error: stderr.trim() || `tar exited ${code}` }),
    );
  });
}

export type ImportResult = {
  imported: string[];
  skipped: Array<{ name: string; reason: string }>;
  error?: string;
};

/**
 * Extracts an uploaded archive back into the profiles directory.
 *
 * Extraction goes to a temporary directory first and only whole, correctly named top-level
 * directories are then moved into place: an archive is untrusted input, and this way nothing
 * it contains can land outside the profiles root or half-overwrite a live profile. (GNU tar
 * refuses `..` members on its own, so this is the second lock rather than the only one.)
 *
 * An existing profile of the same name is kept unless `replace` is set, and one a browser has
 * open is never touched.
 */
export async function importCfProfiles(
  input: Readable,
  opts: { replace?: boolean } = {},
): Promise<ImportResult> {
  const root = cfProfilesRoot();
  mkdirSync(root, { recursive: true });
  // "tmp-" so the staging directory is invisible to the profile list and to LRU trimming
  const staging = mkdtempSync(path.join(root, "tmp-import-"));

  try {
    const extract = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const tar = spawn("tar", ["-xzf", "-", "-C", staging, "--no-same-owner"], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      tar.stderr.on("data", (chunk) => {
        stderr += String(chunk).slice(0, 2_000);
      });
      tar.on("error", (err) => resolve({ ok: false, error: err.message }));
      tar.on("close", (code) =>
        resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `tar exited ${code}` }),
      );
      input.on("error", () => tar.kill());
      input.pipe(tar.stdin);
    });
    if (!extract.ok)
      return { imported: [], skipped: [], error: extract.error ?? "Archive could not be read" };

    const entries = readdirSync(staging, { withFileTypes: true });
    const imported: string[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];

    for (const entry of entries) {
      const name = entry.name;
      if (!entry.isDirectory() || !CF_PROFILE_NAME_RE.test(name)) {
        skipped.push({ name, reason: "Not a profile directory" });
        continue;
      }
      const target = path.join(root, name);
      if (existsSync(target)) {
        if (!opts.replace) {
          skipped.push({ name, reason: "Already exists" });
          continue;
        }
        if (cfProfileInUse(name)) {
          skipped.push({ name, reason: "A browser has this profile open" });
          continue;
        }
        rmSync(target, { recursive: true, force: true });
      }
      try {
        renameSync(path.join(staging, name), target);
        // Imported by hand, so LRU trimming leaves it alone
        markCfProfileManaged(target);
        imported.push(name);
      } catch (err: any) {
        skipped.push({ name, reason: err?.message ?? String(err) });
      }
    }

    if (!imported.length && !skipped.length)
      return { imported, skipped, error: "Archive contained no profiles" };
    return { imported, skipped };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
