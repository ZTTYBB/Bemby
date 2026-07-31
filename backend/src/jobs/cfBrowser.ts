import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { SocksClient } from "socks";
import type { BrowserContext, Page } from "playwright-core";
import { cfTuning } from "./cfTuning";
import { applyCfFontEnv } from "./cfFonts";
import { anyCfLicenseKey, cfLicenseUsage, leaseCfLicenseKey } from "./cfLicense";
import { dataDir } from "./paths";
import { cfExitGeo, type CfExitGeo } from "../tg/proxyProviders";

// The browser behind the Cloudflare solver: CloakBrowser, a Chromium built with
// source-level fingerprint patches (canvas, WebGL, audio, fonts, WebRTC, TLS,
// navigator.webdriver) and driven through Playwright. Nothing here decides whether a
// challenge passed -- that is cloudflare.ts; this module only produces a page to work with.
//
// The image ships without a browser to stay small. The stealth binary (~200MB) is
// downloaded on demand into the data dir, which is a volume, so it survives a restart and
// an upgrade.

/** Data-dir subfolder CloakBrowser caches its Chromium builds in. */
export function cloakCacheDir(): string {
  return path.join(dataDir(), "cloakbrowser");
}

/** Data-dir subfolder holding one browser profile per exit. */
function cfProfilesRoot(): string {
  return path.join(dataDir(), "cf-profiles");
}

/**
 * CloakBrowser is configured through the environment, so it is set up before any call into
 * the library. Anything the operator has already set is left alone.
 *
 * Auto-update is off: left on, the library downloads a new 200MB build in the background
 * the moment a job launches a browser, onto the user's data volume and over whatever
 * bandwidth the job is using. Settings has a Reinstall button for that instead.
 */
function applyCloakEnv(): void {
  if (!process.env.CLOAKBROWSER_CACHE_DIR) process.env.CLOAKBROWSER_CACHE_DIR = cloakCacheDir();
  if (!process.env.CLOAKBROWSER_AUTO_UPDATE) process.env.CLOAKBROWSER_AUTO_UPDATE = "false";
}

// The library is ESM-only and the backend compiles to CommonJS, so a plain import would be
// downlevelled to require() and fail. This keeps it a real dynamic import.
type CloakModule = typeof import("cloakbrowser");
const importEsm = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<unknown>;
let cloakModule: Promise<CloakModule> | undefined;
function cloak(): Promise<CloakModule> {
  applyCloakEnv();
  cloakModule ??= importEsm("cloakbrowser") as Promise<CloakModule>;
  return cloakModule;
}

/**
 * Asks CloakBrowser's server what a licence key is worth. A key that was mistyped or has
 * lapsed otherwise shows up only as jobs quietly running the older free build.
 */
export async function checkCfLicenseKey(key: string): Promise<{
  valid: boolean;
  plan?: string;
  expires?: string;
  error?: string;
}> {
  try {
    const { validateLicense } = await cloak();
    const info = await validateLicense(key);
    if (!info) return { valid: false, error: "CloakBrowser could not be reached" };
    return { valid: info.valid, plan: info.plan, expires: info.expires ?? undefined };
  } catch (err: any) {
    return { valid: false, error: err?.message ?? String(err) };
  }
}

/** Segments of a CloakBrowser version ("146.0.7680.177.5"), for comparing installs. */
function versionParts(v: string): number[] {
  return v.split(".").map((n) => Number(n) || 0);
}

function versionNewer(a: string, b: string): boolean {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/** A build a licence key unlocks, or the one that needs none. */
type BuildTier = "keyed" | "free";

type CachedBuild = { version: string; tier: BuildTier; exe: string };

/**
 * The stealth Chromium builds in the cache dir. Read off the filesystem rather than asked
 * of the library, so the settings page can report what is installed without an async call
 * -- and without the library reaching out to check for an update.
 *
 * A keyed build unpacks into a `-pro` directory whether the key is free or paid.
 */
function cachedBuilds(): CachedBuild[] {
  // The layout CloakBrowser unpacks into. Linux is what the image runs; the others are
  // for a developer machine.
  const exeName =
    process.platform === "darwin"
      ? "Chromium.app/Contents/MacOS/Chromium"
      : process.platform === "win32"
        ? "chrome.exe"
        : "chrome";

  const out: CachedBuild[] = [];
  try {
    for (const name of readdirSync(cloakCacheDir())) {
      const match = /^chromium-([\d.]+)(-pro)?$/.exec(name);
      if (!match) continue;
      const exe = path.join(cloakCacheDir(), name, exeName);
      // A directory with no executable is what a download that died halfway leaves behind
      if (!existsSync(exe)) continue;
      out.push({ version: match[1], tier: match[2] ? "keyed" : "free", exe });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => (versionNewer(a.version, b.version) ? -1 : 1));
}

/** The build that would launch for `tier`, falling back to whatever is installed. */
function resolvedBuild(tier?: BuildTier): CachedBuild | undefined {
  const builds = cachedBuilds();
  return (tier ? builds.find((b) => b.tier === tier) : undefined) ?? builds[0];
}

/**
 * A CloakBrowser binary the operator pinned themselves, which is how an older build is
 * rolled back to. The library reads this variable directly as well, so honouring it here
 * only keeps the settings page in step with what will launch.
 */
function pinnedBinary(): string | undefined {
  const pin = process.env.CLOAKBROWSER_BINARY_PATH;
  return pin && existsSync(pin) ? pin : undefined;
}

// The previous solver launched whatever PUPPETEER_EXECUTABLE_PATH named, and installs that
// were set up then still carry it. It is deliberately not honoured any more: a stock
// Chromium has none of the fingerprint patches, so a job pointed at one is not solving
// anything -- it just looks like it is.
let warnedLegacyPin = false;
function warnLegacyPin(): void {
  if (warnedLegacyPin || !process.env.PUPPETEER_EXECUTABLE_PATH) return;
  warnedLegacyPin = true;
  console.warn(
    `[cfBrowser] ignoring PUPPETEER_EXECUTABLE_PATH (${process.env.PUPPETEER_EXECUTABLE_PATH}): ` +
      "the solver only launches CloakBrowser builds. Remove it from your .env, and delete " +
      "the browser it points at to reclaim the space.",
  );
}

/**
 * The browser that will launch: the operator's pin, else the downloaded stealth build of
 * the tier matching whether a licence key is in hand -- a keyed build declines to run
 * without one.
 */
export function chromiumExecutable(tier?: BuildTier): string | undefined {
  warnLegacyPin();
  return pinnedBinary() ?? resolvedBuild(tier)?.exe;
}

export function isChromiumInstalled(): boolean {
  return !!chromiumExecutable();
}

/** Tier of the build that is installed, for the settings view. */
export function installedBuildTier(): BuildTier | undefined {
  if (pinnedBinary()) return undefined;
  return resolvedBuild()?.tier;
}

/**
 * A licence key is configured but the build it unlocks has not been downloaded, so jobs
 * are still launching the older free one. Downloading is deliberate rather than automatic
 * (see the launch pin), so this is what tells the operator there is something to fetch.
 */
export function keyedBuildPending(): boolean {
  if (pinnedBinary()) return false;
  const hasKey = !!process.env.CLOAKBROWSER_LICENSE_KEY?.trim() || cfLicenseUsage().total > 0;
  return hasKey && !cachedBuilds().some((build) => build.tier === "keyed");
}

/**
 * Version of the browser that will launch, e.g. "CloakBrowser 150.0.7871.114.4".
 *
 * Read from the directory the build was unpacked into rather than by running it: the
 * keyed build refuses to start without its licence key, and the key lives in the database
 * rather than this process's environment, so asking the binary reports nothing at all --
 * which is how the settings page ended up naming the build it had replaced.
 */
export function chromiumVersion(): string | undefined {
  const build = resolvedBuild();
  if (build && !pinnedBinary()) return `CloakBrowser ${build.version}`;

  // A pinned binary has no version in its path, so it has to be asked
  const exe = pinnedBinary();
  if (!exe) return undefined;
  try {
    const out = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 15_000 });
    return `${out.stdout ?? ""}`.trim().split("\n")[0] || undefined;
  } catch {
    return undefined;
  }
}

/** Path of the browser that will launch, so the settings page can name it exactly. */
export function chromiumPath(): string | undefined {
  return chromiumExecutable();
}

/**
 * Downloads the stealth Chromium into the data dir. Long-running (~200MB) but needs no
 * root: it writes to the data volume as the app's own user.
 *
 * `force` clears the cache first, which is how the browser is moved to a newer build.
 */
export async function installCfChromium(force = false): Promise<{ ok: boolean; output: string }> {
  applyCloakEnv();
  const lines: string[] = [];
  try {
    mkdirSync(cloakCacheDir(), { recursive: true });
  } catch (err: any) {
    return { ok: false, output: `Cannot write to ${cloakCacheDir()}: ${err?.message ?? err}` };
  }

  // Any configured key will do here: which build is downloaded is the same question for
  // all of them, and this is not a browser session, so it takes no seat.
  const licenseKey = anyCfLicenseKey();
  try {
    const { ensureBinary, binaryInfo } = await cloak();
    // Only the build being replaced is cleared, not the whole cache: the other tier is
    // what an overflow launch falls back to, and re-downloading it is another 200MB.
    if (force) {
      const dropped = removeBuild(licenseKey ? "keyed" : "free");
      lines.push(dropped ? `Cleared ${dropped}` : "Nothing cached to clear");
    }
    const exe = await ensureBinary(licenseKey);
    const info = binaryInfo();
    lines.push(`CloakBrowser ${info.version} (${info.tier} build) at ${exe}`);
    if (!licenseKey) {
      lines.push(
        "No licence key configured, so this is the older free build. Add a free key in " +
          "Settings for the current one, which passes more challenges.",
      );
    }
  } catch (err: any) {
    return { ok: false, output: `${lines.join("\n")}\n${err?.message ?? err}`.trim() };
  }

  if (!isChromiumInstalled()) {
    return { ok: false, output: `${lines.join("\n")}\nThe download finished but no browser is in ${cloakCacheDir()}` };
  }
  const version = chromiumVersion();
  if (version) lines.push(version);
  const dropped = pruneOldBuilds();
  if (dropped) lines.push(dropped);
  const reclaimed = pruneLegacyBrowsers();
  if (reclaimed) lines.push(reclaimed);
  return { ok: true, output: lines.join("\n") };
}

/** Drops the cached build of one tier, so the next install fetches it again. */
function removeBuild(tier: BuildTier): string | undefined {
  const build = cachedBuilds().find((b) => b.tier === tier);
  if (!build) return undefined;
  const dir = path.dirname(build.exe);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err: any) {
    console.warn(`[cfBrowser] could not remove ${dir}: ${err?.message ?? err}`);
    return undefined;
  }
  return path.basename(dir);
}

/**
 * Keeps the newest build of each tier and drops the rest. An update leaves the build it
 * replaced behind, and each is several hundred MB unpacked, which on a self-hosted volume
 * adds up fast. Both tiers are kept because which one launches depends on whether a
 * licence key is free at the time.
 */
function pruneOldBuilds(): string | undefined {
  const keep = new Set(
    (["keyed", "free"] as BuildTier[])
      .map((tier) => cachedBuilds().find((b) => b.tier === tier))
      .filter((b): b is CachedBuild => !!b)
      .map((b) => path.dirname(b.exe)),
  );
  if (!keep.size) return undefined;
  const dropped: string[] = [];
  try {
    for (const name of readdirSync(cloakCacheDir())) {
      if (!/^chromium-/.test(name)) continue;
      const full = path.join(cloakCacheDir(), name);
      if (keep.has(full)) continue;
      rmSync(full, { recursive: true, force: true });
      dropped.push(name);
    }
  } catch {
    /* housekeeping only */
  }
  return dropped.length ? `Removed ${dropped.length} superseded build(s): ${dropped.join(", ")}` : undefined;
}

/**
 * Removes the browsers earlier versions installed: the Playwright download and the
 * Alpine-era apk root. Both are caches this app wrote and no longer launches, and between
 * them they are most of a gigabyte on the user's volume.
 */
function pruneLegacyBrowsers(): string | undefined {
  const stale = ["pw-browsers", ".pw-browsers", "cf-chromium"]
    .map((name) => path.join(dataDir(), name))
    .filter((dir) => existsSync(dir));
  if (!stale.length) return undefined;
  for (const dir of stale) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err: any) {
      console.warn(`[cfBrowser] could not remove ${dir}: ${err?.message ?? err}`);
    }
  }
  return `Removed the browser left by the previous solver (${stale.map((d) => path.basename(d)).join(", ")})`;
}

// ── Virtual display ──────────────────────────────────────────────────────────
//
// The browser runs headed: a challenge is scored on far more than the headless flag, and
// the pass rate headed is not close. On a server there is no display, so one Xvfb is
// started for the process and every browser shares it.

let displayPromise: Promise<string | undefined> | undefined;

function displaySocket(display: string): string {
  return `/tmp/.X11-unix/X${display.replace(/^:/, "").split(".")[0]}`;
}

/**
 * Starts one X server on a free display number. The socket appearing is what proves it
 * came up: a process that died is still an unreaped child that looks alive.
 */
async function startXvfb(): Promise<string | undefined> {
  for (let n = 99; n < 110; n++) {
    const display = `:${n}`;
    if (existsSync(displaySocket(display))) continue;

    // Sized to the desktop the stealth build reports to a page, so the window it opens
    // sits inside a screen of a plausible size rather than filling a small one
    const proc = spawn("Xvfb", [display, "-screen", "0", "1920x1080x24", "-nolisten", "tcp"], {
      stdio: "ignore",
    });
    // Not on the path at all, as opposed to started and then exited
    let missing = false;
    const died = new Promise<false>((resolve) => {
      proc.once("error", () => {
        missing = true;
        resolve(false);
      });
      proc.once("exit", () => resolve(false));
    });
    const up = (async () => {
      for (let i = 0; i < 40; i++) {
        if (existsSync(displaySocket(display))) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      return false;
    })();

    if (await Promise.race([died, up])) {
      // Killed with the app so a restart does not leave X servers behind
      process.once("exit", () => proc.kill());
      console.log(`[cfBrowser] started Xvfb on ${display}`);
      return display;
    }
    proc.kill();
    if (missing) break; // trying other display numbers cannot help
  }
  return undefined;
}

/**
 * A display for the headed browser: the one already in the environment, else an Xvfb of
 * our own. Undefined when there is none to be had, which leaves the browser headless --
 * it still runs, it just passes fewer challenges.
 */
async function ensureDisplay(): Promise<string | undefined> {
  displayPromise ??= (async () => {
    const existing = process.env.DISPLAY;
    if (existing && existsSync(displaySocket(existing))) return existing;
    const started = await startXvfb();
    if (!started) {
      console.warn(
        "[cfBrowser] no X display and Xvfb could not be started; the browser will run " +
          "headless, which passes fewer challenges. Install xvfb on the host.",
      );
      return undefined;
    }
    process.env.DISPLAY = started;
    return started;
  })();
  return displayPromise;
}

// ── Profiles ─────────────────────────────────────────────────────────────────
//
// One profile per exit, so cookies -- above all the cf_clearance a solved challenge issues
// -- outlive the browser. Without one every attempt arrives as a first-time visitor, which
// is exactly what a managed challenge is looking for.

/**
 * Stable id for an exit, used to name its profile and remember its geography. The proxy
 * URL is hashed rather than stored: it carries credentials, and this ends up on disk.
 */
function exitKey(proxyUrl?: string): string {
  return proxyUrl ? createHash("sha1").update(proxyUrl).digest("hex").slice(0, 12) : "direct";
}

/**
 * The device fingerprint seed for an exit. CloakBrowser picks a random one per launch,
 * which would hand the same site a different machine every run -- while the profile hands
 * it the same cookies. Derived from the exit key instead, so an exit keeps one identity
 * for as long as its profile does.
 */
function fingerprintSeed(key: string): number {
  const digest = createHash("sha1").update(`bemby-fingerprint:${key}`).digest();
  return 10_000 + (digest.readUInt32BE(0) % 90_000);
}

// One Chromium at a time per profile: two sharing a user-data-dir corrupt it, and jobs can
// run concurrently. The loser of the race gets a throwaway profile instead.
const profilesInUse = new Set<string>();

// Chromium writes inside Default/, which leaves the profile's own mtime at creation time,
// so last use is recorded here instead.
const USED_MARKER = ".bemby-last-used";

function lastUsedAt(dir: string): number {
  try {
    return statSync(path.join(dir, USED_MARKER)).mtimeMs;
  } catch {
    try {
      return statSync(dir).mtimeMs;
    } catch {
      return 0;
    }
  }
}

/** Drops the least recently used profiles, keeping the newest maxProfiles of them. */
function pruneProfiles(root: string): void {
  const tune = cfTuning();
  try {
    const dirs = readdirSync(root)
      .filter((name) => !profilesInUse.has(name) && !name.startsWith("tmp-"))
      .map((name) => ({ full: path.join(root, name), usedAt: lastUsedAt(path.join(root, name)) }))
      .sort((a, b) => b.usedAt - a.usedAt);
    for (const stale of dirs.slice(tune.maxProfiles)) {
      rmSync(stale.full, { recursive: true, force: true });
    }
  } catch {
    /* housekeeping only */
  }
}

type ClaimedProfile = { dir: string; release: () => void };

/**
 * The profile directory for this exit. When it is already open elsewhere -- or cannot be
 * created -- a throwaway one is used instead, which is thrown away with the browser.
 */
function claimProfile(key: string): ClaimedProfile {
  const throwaway = (): ClaimedProfile => {
    const root = existsSync(cfProfilesRoot()) ? cfProfilesRoot() : os.tmpdir();
    const dir = mkdtempSync(path.join(root, "tmp-"));
    return { dir, release: () => rmSync(dir, { recursive: true, force: true }) };
  };

  if (profilesInUse.has(key)) return throwaway();
  const dir = path.join(cfProfilesRoot(), key);
  try {
    mkdirSync(dir, { recursive: true });
    // A browser that was killed leaves these behind, and Chromium then refuses the profile
    // as "already in use"
    for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      rmSync(path.join(dir, lock), { force: true });
    }
    writeFileSync(path.join(dir, USED_MARKER), "");
    profilesInUse.add(key);
    pruneProfiles(cfProfilesRoot());
    return { dir, release: () => profilesInUse.delete(key) };
  } catch (err: any) {
    console.warn(`[cfBrowser] no persistent profile (${err?.message ?? err})`);
    return throwaway();
  }
}

// ── Proxies ──────────────────────────────────────────────────────────────────

type SocksBridge = { port: number; close: () => void };

/**
 * A loopback HTTP proxy in front of an authenticated SOCKS5 exit, for the browser's
 * lifetime. Chromium's own SOCKS support is the one part of the proxy chain that varies by
 * build, and Bemby's proxies are almost all socks5://user:pass@host:port -- bridging them
 * keeps that off the critical path. Only CONNECT is handled; challenge pages are https.
 */
function startSocksBridge(url: URL): Promise<SocksBridge> {
  const proxy = {
    host: url.hostname,
    port: Number(url.port),
    type: (url.protocol === "socks4:" ? 4 : 5) as 4 | 5,
    userId: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  };

  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());

    client.once("data", async (chunk) => {
      const head = chunk.toString("latin1");
      const target = head.match(/^CONNECT\s+([^\s:]+):(\d+)/i);
      if (!target) {
        client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
        return;
      }
      try {
        const { socket } = await SocksClient.createConnection({
          proxy,
          command: "connect",
          // Hostname is passed through so the proxy resolves it, as socks5h does
          destination: { host: target[1], port: Number(target[2]) },
        });
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy());
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.pipe(client);
        client.pipe(socket);
      } catch {
        client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}

/** The proxy CloakBrowser is launched with, plus whatever has to be shut down after. */
async function resolveProxy(proxyUrl?: string): Promise<{ proxy?: string; close: () => void }> {
  if (!proxyUrl) return { close: () => {} };
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    console.warn("[cfBrowser] proxy URL could not be parsed; going out direct");
    return { close: () => {} };
  }
  if (!/^socks/i.test(url.protocol) || !url.username) return { proxy: proxyUrl, close: () => {} };

  try {
    const bridge = await startSocksBridge(url);
    return { proxy: `http://127.0.0.1:${bridge.port}`, close: bridge.close };
  } catch (err: any) {
    console.error(`[cfBrowser] SOCKS bridge failed: ${err?.message ?? err}`);
    return { close: () => {} };
  }
}

// ── Launch ───────────────────────────────────────────────────────────────────

/**
 * Runs `launch` with the library pointed at a binary already on disk.
 *
 * `CLOAKBROWSER_BINARY_PATH` is the only thing that stops the library resolving a binary
 * of its own -- passing an executable through the launch options overrides which one
 * finally starts, but the resolve (and, with nothing cached for that tier, a ~200MB
 * download) has already happened by then. That download would land in the middle of a
 * job, over the connection the job is using.
 *
 * Launches are serialised through here because the setting is process-wide and two
 * concurrent ones can want different tiers. The section covers the launch call only, so
 * the queue is a second or two, and the previous value is put back for the settings page.
 */
let launchGate: Promise<unknown> = Promise.resolve();

function withBinaryPin<T>(exe: string | undefined, launch: () => Promise<T>): Promise<T> {
  const run = launchGate.then(async () => {
    const previous = process.env.CLOAKBROWSER_BINARY_PATH;
    if (exe) process.env.CLOAKBROWSER_BINARY_PATH = exe;
    try {
      return await launch();
    } finally {
      if (previous === undefined) delete process.env.CLOAKBROWSER_BINARY_PATH;
      else process.env.CLOAKBROWSER_BINARY_PATH = previous;
    }
  });
  launchGate = run.catch(() => {});
  return run;
}

export type LaunchedBrowser = {
  context: BrowserContext;
  page: Page;
  /** Stable id of the exit this browser goes out through. */
  key: string;
  /** What is known about where it comes out, if anything yet. */
  geo?: CfExitGeo;
  /** Closes the browser and releases the profile, bridge and everything else. */
  close: () => Promise<void>;
};

/**
 * Launches the stealth browser for one exit: headed on the shared display, on that exit's
 * own profile, with the clock and language of the country the exit comes out in.
 *
 * Timezone and locale are passed to CloakBrowser rather than emulated over CDP, because
 * the binary applies them as launch flags -- CDP emulation is itself detectable.
 */
export async function launchCfBrowser(proxyUrl?: string): Promise<LaunchedBrowser> {
  const tune = cfTuning();
  if (!isChromiumInstalled()) {
    throw new Error(
      "The Cloudflare solver browser is not installed. Enable it in Settings to download it into the data dir.",
    );
  }

  // Before the browser is spawned: fontconfig is read from the environment it inherits.
  // A browser with no fonts measures text like nothing else on the web, which is exactly
  // the sort of thing a challenge scores against.
  applyCfFontEnv();

  const display = await ensureDisplay();
  const key = exitKey(proxyUrl);
  const geo = cfExitGeo(key);
  const profile = claimProfile(key);
  const proxy = await resolveProxy(proxyUrl);
  // One seat per key, held for as long as this browser lives. When they are all out,
  // wait for one: a free key is a single concurrent session, so the alternative is
  // launching the keyed build unlicensed, which it refuses. The wait is bounded by the
  // same ceiling one action gets, so it cannot outlast the job that is waiting.
  let lease = await leaseCfLicenseKey();
  if (!lease.key && cfLicenseUsage().total) {
    console.log("[cfBrowser] every licence seat is taken; waiting for one to free up");
    lease = await leaseCfLicenseKey(tune.budgetMs);
    if (!lease.key) {
      console.warn(
        "[cfBrowser] no licence seat came free, so this browser launches without a key. " +
          "Add another key in Settings to run more solvers at once.",
      );
    }
  }

  // The build that matches whether a key is in hand: a keyed binary declines to run
  // without one, and a free one has no use for it
  const executablePath = chromiumExecutable(lease.key ? "keyed" : "free");

  try {
    const { launchPersistentContext } = await cloak();
    const context = await withBinaryPin(executablePath, () =>
      launchPersistentContext({
        userDataDir: profile.dir,
        headless: !display,
        proxy: proxy.proxy,
        ...(lease.key ? { licenseKey: lease.key } : {}),
        // Human-like pointer curves and keystroke timing on the driver's own methods
        humanize: true,
        ...(geo?.tz ? { timezone: geo.tz } : {}),
        ...(geo?.lang ? { locale: geo.lang } : {}),
        args: [
          // One machine per exit, kept across runs alongside its cookies
          `--fingerprint=${fingerprintSeed(key)}`,
          // The container has no user namespaces to sandbox into, and /dev/shm is small
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          // Render through Chromium's own bundled SwiftShader rather than the system GL
          // stack. The image purges Mesa to stay small, which leaves no GLX for ANGLE to
          // start from ("GLX is not present"), and ANGLE does not fall back on its own.
          // This keeps WebGL present, which matters: a browser reporting none reads as
          // automation. Do not drop these without putting Mesa back in the image.
          "--use-gl=angle",
          "--use-angle=swiftshader",
          // A profile that is reused must not reopen the last session or offer to restore a
          // crashed one, either of which would leave a dialog over the page
          "--no-first-run",
          "--no-default-browser-check",
          "--hide-crash-restore-bubble",
          // A window Chromium considers occluded gets its timers, rendering and observer
          // callbacks throttled, which stalls anything waiting on them
          "--window-position=0,0",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-background-timer-throttling",
        ],
        launchOptions: { timeout: tune.navTimeoutMs, executablePath },
      }),
    );

    // Bounds every driver call, so one wedged renderer cannot swallow the step budget
    context.setDefaultTimeout(tune.protocolTimeoutMs);
    context.setDefaultNavigationTimeout(tune.navTimeoutMs);

    const pages = context.pages();
    const page = pages[0] ?? (await context.newPage());
    // A reused profile reopens the tabs the last session left behind, and they pile up run
    // after run. Worse, a restored tab may be the active one, and Chromium delivers
    // pointer presses only to the active tab.
    for (const stray of pages.slice(1)) await stray.close().catch(() => {});
    if (pages.length > 1) {
      console.log(`[cfBrowser] closed ${pages.length - 1} restored tab(s) from the saved profile`);
    }
    await page.bringToFront().catch(() => {});

    return {
      context,
      page,
      key,
      geo,
      close: async () => {
        await context.close().catch(() => {});
        proxy.close();
        profile.release();
        lease.release();
      },
    };
  } catch (err) {
    proxy.close();
    profile.release();
    lease.release();
    throw err;
  }
}
