import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { SocksClient } from "socks";
import { connect } from "puppeteer-real-browser";
import {
  cfExitGeo,
  rememberCfExitGeo,
  type CfExitGeo,
  type ProxyCandidate,
} from "../tg/proxyProviders";
type Browser = Awaited<ReturnType<typeof connect>>["browser"];
type Page = Awaited<ReturnType<typeof connect>>["page"];

// Completes a checkin that hands back a URL behind Cloudflare's "I am not a bot"
// (managed challenge / Turnstile). A real headless Chromium loads the URL and
// waits for the challenge to clear; because Bemby runs on the user's own host,
// the browser exits from the same IP (and proxy, if set) as expected, so simply
// loading the page registers the checkin server-side.

// The image ships without a browser to stay small. When the user enables Cloudflare
// solving, Chromium is downloaded on demand into the data dir (a persistent volume) so it
// survives restarts. The download is Playwright's Chromium build -- the same one that
// works on a developer machine -- which needs glibc, hence the Debian-based image. Older
// installs put Alpine's musl apk build in an alternate root instead; that layout is still
// resolved so an upgraded install keeps working until the browser is reinstalled.

function dataDir(): string {
  return path.dirname(process.env.DB_PATH ?? path.resolve(process.cwd(), "data/bemby.db"));
}

/** Data-dir subfolder holding the on-demand Chromium download (Playwright layout). */
export function cfBrowsersRoot(): string {
  return path.join(dataDir(), "pw-browsers");
}

/** Legacy data-dir subfolder: the musl apk install used by the Alpine-based image. */
export function cfChromiumRoot(): string {
  return path.join(dataDir(), "cf-chromium");
}

/** Newest Playwright Chromium in the data dir. Headed build only -- the shell cannot pass a challenge. */
function downloadedChromium(): string | undefined {
  try {
    return readdirSync(cfBrowsersRoot())
      .map((name) => /^chromium-(\d+)$/.exec(name))
      .filter((m): m is RegExpExecArray => !!m)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .map((m) => path.join(cfBrowsersRoot(), m[0], "chrome-linux/chrome"))
      .find((exe) => existsSync(exe));
  } catch {
    return undefined;
  }
}

/** Data-dir subfolder holding one browser profile per exit. */
function cfProfilesRoot(): string {
  return path.join(dataDir(), "cf-profiles");
}

/**
 * Stable id for an exit, used to name its profile and remember its geography. The proxy
 * URL is hashed rather than stored: it carries credentials, and this ends up on disk.
 */
function exitKey(proxyUrl?: string): string {
  return proxyUrl ? createHash("sha1").update(proxyUrl).digest("hex").slice(0, 12) : "direct";
}

// Profiles are kept for the exits used most recently; a Chromium profile is tens of MB,
// and a large proxy pool would otherwise fill the data volume.
const MAX_PROFILES = 12;
// One Chromium at a time per profile: two sharing a user-data-dir corrupt it, and jobs
// can run concurrently. The loser of the race gets a throwaway profile instead.
const profilesInUse = new Set<string>();

// Chromium writes inside Default/, which leaves the profile's own mtime at creation
// time, so last use is recorded here instead.
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

/** Drops the least recently used profiles, leaving the newest MAX_PROFILES in place. */
function pruneProfiles(root: string): void {
  try {
    const dirs = readdirSync(root)
      .filter((name) => !profilesInUse.has(name))
      .map((name) => ({ full: path.join(root, name), usedAt: lastUsedAt(path.join(root, name)) }))
      .sort((a, b) => b.usedAt - a.usedAt);
    for (const stale of dirs.slice(MAX_PROFILES)) {
      rmSync(stale.full, { recursive: true, force: true });
    }
  } catch {
    /* housekeeping only */
  }
}

/**
 * A profile directory for this exit, so cookies -- above all the cf_clearance a solved
 * challenge issues -- outlive the browser. Without one every attempt arrives as a
 * first-time visitor, which is exactly what a managed challenge is looking for.
 *
 * Returns no directory when the profile is already open elsewhere, leaving Chromium to
 * use a throwaway one rather than two browsers writing the same profile.
 */
function claimProfile(key: string): { dir?: string; release: () => void } {
  if (profilesInUse.has(key)) return { release: () => {} };
  const dir = path.join(cfProfilesRoot(), key);
  try {
    mkdirSync(dir, { recursive: true });
    // A browser that was killed leaves these behind, and Chromium then refuses the
    // profile as "already in use"
    for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      rmSync(path.join(dir, lock), { force: true });
    }
    writeFileSync(path.join(dir, USED_MARKER), "");
    profilesInUse.add(key);
    pruneProfiles(cfProfilesRoot());
    return { dir, release: () => profilesInUse.delete(key) };
  } catch (err: any) {
    console.warn(`[cloudflare] no persistent profile (${err?.message ?? err})`);
    return { release: () => {} };
  }
}

// Primary timezone and locale per country, for aligning the browser with its exit IP: a
// residential address in Japan reporting UTC and en-US is a cheap signal to check.
// Countries not listed are left alone rather than guessed at.
const COUNTRY_LOCALE: Record<string, { tz: string; lang: string }> = {
  AE: { tz: "Asia/Dubai", lang: "ar-AE" },
  AR: { tz: "America/Argentina/Buenos_Aires", lang: "es-AR" },
  AT: { tz: "Europe/Vienna", lang: "de-AT" },
  AU: { tz: "Australia/Sydney", lang: "en-AU" },
  BE: { tz: "Europe/Brussels", lang: "nl-BE" },
  BR: { tz: "America/Sao_Paulo", lang: "pt-BR" },
  CA: { tz: "America/Toronto", lang: "en-CA" },
  CH: { tz: "Europe/Zurich", lang: "de-CH" },
  CL: { tz: "America/Santiago", lang: "es-CL" },
  CN: { tz: "Asia/Shanghai", lang: "zh-CN" },
  CZ: { tz: "Europe/Prague", lang: "cs-CZ" },
  DE: { tz: "Europe/Berlin", lang: "de-DE" },
  DK: { tz: "Europe/Copenhagen", lang: "da-DK" },
  EE: { tz: "Europe/Tallinn", lang: "et-EE" },
  ES: { tz: "Europe/Madrid", lang: "es-ES" },
  FI: { tz: "Europe/Helsinki", lang: "fi-FI" },
  FR: { tz: "Europe/Paris", lang: "fr-FR" },
  GB: { tz: "Europe/London", lang: "en-GB" },
  HK: { tz: "Asia/Hong_Kong", lang: "zh-HK" },
  HU: { tz: "Europe/Budapest", lang: "hu-HU" },
  ID: { tz: "Asia/Jakarta", lang: "id-ID" },
  IE: { tz: "Europe/Dublin", lang: "en-IE" },
  IL: { tz: "Asia/Jerusalem", lang: "he-IL" },
  IN: { tz: "Asia/Kolkata", lang: "en-IN" },
  IT: { tz: "Europe/Rome", lang: "it-IT" },
  JP: { tz: "Asia/Tokyo", lang: "ja-JP" },
  KR: { tz: "Asia/Seoul", lang: "ko-KR" },
  MX: { tz: "America/Mexico_City", lang: "es-MX" },
  MY: { tz: "Asia/Kuala_Lumpur", lang: "ms-MY" },
  NL: { tz: "Europe/Amsterdam", lang: "nl-NL" },
  NO: { tz: "Europe/Oslo", lang: "nb-NO" },
  NZ: { tz: "Pacific/Auckland", lang: "en-NZ" },
  PH: { tz: "Asia/Manila", lang: "en-PH" },
  PL: { tz: "Europe/Warsaw", lang: "pl-PL" },
  PT: { tz: "Europe/Lisbon", lang: "pt-PT" },
  RO: { tz: "Europe/Bucharest", lang: "ro-RO" },
  RU: { tz: "Europe/Moscow", lang: "ru-RU" },
  SE: { tz: "Europe/Stockholm", lang: "sv-SE" },
  SG: { tz: "Asia/Singapore", lang: "en-SG" },
  TH: { tz: "Asia/Bangkok", lang: "th-TH" },
  TR: { tz: "Europe/Istanbul", lang: "tr-TR" },
  TW: { tz: "Asia/Taipei", lang: "zh-TW" },
  UA: { tz: "Europe/Kyiv", lang: "uk-UA" },
  US: { tz: "America/New_York", lang: "en-US" },
  VN: { tz: "Asia/Ho_Chi_Minh", lang: "vi-VN" },
  ZA: { tz: "Africa/Johannesburg", lang: "en-ZA" },
};

/** Cloudflare's own trace endpoint, which reports the country it sees the request from. */
const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";

/**
 * Points fontconfig at the fonts inside the browser root.
 *
 * The root is an alternate apk root, not a chroot: the browser runs against the image's
 * own filesystem and only finds its libraries there through LD_LIBRARY_PATH. Alpine's
 * fonts.conf lists `/usr/share/fonts` as an absolute path, which in the image is empty --
 * so the fonts the installer put in `<root>/usr/share/fonts` are invisible and the
 * browser renders every glyph as a box. A browser with no fonts at all measures text
 * like nothing else on the web, which is the sort of thing a challenge scores against.
 *
 * Written at launch rather than at install, so a root installed by an earlier version is
 * fixed without reinstalling the browser.
 */
function ensureAltRootFonts(root: string): void {
  const conf = path.join(root, "etc/fonts/local.conf");
  const body = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<!-- Written by Bemby: the browser root is not a chroot, so its font directories have
     to be named absolutely for fontconfig to see them. -->
<fontconfig>
  <dir>${path.join(root, "usr/share/fonts")}</dir>
  <cachedir>${path.join(root, "var/cache/fontconfig")}</cachedir>
</fontconfig>
`;
  try {
    if (!existsSync(path.join(root, "etc/fonts"))) return;
    if (existsSync(conf) && readFileSync(conf, "utf8") === body) return;
    mkdirSync(path.join(root, "var/cache/fontconfig"), { recursive: true });
    writeFileSync(conf, body);
    console.log(`[cloudflare] pointed fontconfig at ${path.join(root, "usr/share/fonts")}`);
  } catch (err: any) {
    console.warn(`[cloudflare] could not write ${conf}: ${err?.message ?? err}`);
  }
}

/**
 * True when this system runs musl rather than glibc, i.e. Alpine. The apk browser in the
 * legacy root is a musl binary: on a glibc image it cannot be executed at all, so it must
 * not be offered -- otherwise an upgraded install reports a browser it cannot launch and
 * never downloads the one it can.
 */
function isMuslSystem(): boolean {
  try {
    const header = (process.report?.getReport() as any)?.header;
    if (header && "glibcVersionRuntime" in header) return !header.glibcVersionRuntime;
  } catch {
    /* fall through to the file check */
  }
  return existsSync("/etc/alpine-release");
}

/**
 * Resolves the Chromium executable: an explicit env path, then the downloaded build in
 * the data dir, then a legacy apk root (Alpine only), then a system browser.
 */
export function chromiumExecutable(): string | undefined {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath && existsSync(envPath)) return envPath;
  const downloaded = downloadedChromium();
  if (downloaded) return downloaded;
  const root = cfChromiumRoot();
  const candidates = [
    ...(isMuslSystem()
      ? [
          path.join(root, "usr/lib/chromium/chrome"),
          path.join(root, "usr/lib/chromium/chromium"),
          path.join(root, "usr/bin/chromium-browser"),
        ]
      : []),
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
  return candidates.find((p) => existsSync(p));
}

export function isChromiumInstalled(): boolean {
  return !!chromiumExecutable();
}

/** Version of the resolved browser, e.g. "Chromium 151.0.7922.34". */
export function chromiumVersion(): string | undefined {
  const exe = chromiumExecutable();
  if (!exe) return undefined;
  try {
    const out = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 15_000 });
    return `${out.stdout ?? ""}`.trim().split("\n")[0] || undefined;
  } catch {
    return undefined;
  }
}

/** Playwright's browser installer, inside the app's own node_modules. */
function playwrightCli(): string | undefined {
  try {
    return createRequire(__filename).resolve("playwright-core/cli.js");
  } catch {
    // Compiled and bundled layouts differ; fall back to the conventional location
    const guess = path.resolve(process.cwd(), "node_modules/playwright-core/cli.js");
    return existsSync(guess) ? guess : undefined;
  }
}

/**
 * Downloads Chromium into the data dir with Playwright's installer -- the same build a
 * developer machine runs, which is the one that gets through a challenge. Long-running
 * (~170MB), but needs no root: it writes to the data volume as the app's own user.
 *
 * `force` downloads again even when a browser is already there, which is how the browser
 * is updated to whatever the installed Playwright version now ships.
 */
export function installCfChromium(force = false): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const cli = playwrightCli();
    if (!cli) {
      resolve({
        ok: false,
        output:
          "playwright-core is not installed next to the app, so the browser cannot be " +
          "downloaded. For local development, set PUPPETEER_EXECUTABLE_PATH to a Chromium " +
          "binary in backend/.env and restart.",
      });
      return;
    }

    const root = cfBrowsersRoot();
    try {
      mkdirSync(root, { recursive: true });
    } catch (err: any) {
      resolve({ ok: false, output: `Cannot write to ${root}: ${err?.message ?? err}` });
      return;
    }

    const proc = spawn(process.execPath, [cli, "install", "chromium", ...(force ? ["--force"] : [])], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: root },
    });
    let out = "";
    const cap = (b: Buffer) => {
      out += b.toString();
      if (out.length > 8000) out = out.slice(-8000);
    };
    proc.stdout.on("data", cap);
    proc.stderr.on("data", cap);
    proc.on("error", (err) => resolve({ ok: false, output: `${out}\n${err.message}` }));
    proc.on("close", (code) => {
      if (code === 0) pruneHeadlessShells(root);
      const ok = code === 0 && isChromiumInstalled();
      const version = ok ? chromiumVersion() : undefined;
      resolve({ ok, output: version ? `${out}\n${version}` : out });
    });
  });
}

/**
 * Removes the headless shell that comes with the browser. Only the headed build is ever
 * launched (a challenge is not passed headless), and the shell is ~110MB on a volume that
 * also holds the user's data.
 */
function pruneHeadlessShells(root: string): void {
  try {
    for (const name of readdirSync(root)) {
      if (/^chromium_headless_shell-/.test(name)) {
        rmSync(path.join(root, name), { recursive: true, force: true });
      }
    }
  } catch {
    /* housekeeping only */
  }
}

export type CheckinPageResult = {
  /** Reached the destination with no Cloudflare interstitial remaining. */
  ok: boolean;
  /** A Cloudflare challenge was shown at some point. */
  challenged: boolean;
  /** Final page's visible text, for success/fail keyword matching. */
  text: string;
  /** Host of the final URL (kept for logs; full URL is sensitive). */
  finalHost: string;
  /** Label of the checkin control pressed inside a Mini App page, if any. */
  inAppAction?: string;
  /** Id of the proxy the accepted (or last) attempt went through. */
  proxyId?: string;
  /** Human-readable name of that proxy, for the job log. */
  proxyLabel?: string;
  /** How many exits were tried. */
  attempts?: number;
  /**
   * Exits that were used and did not get through. The accepted one is left out, so it
   * stays available, while a retry skips the ones already known to be refused.
   */
  refusedProxyIds?: string[];
  /**
   * The failure is about this exit -- a refused challenge, a page that never loaded -- so
   * another is worth trying. False for a failure inside the app, which every exit meets
   * alike: rotating through the pool then only wastes the budget.
   */
  exitRelated?: boolean;
  /** Why the attempt is not ok, in plain words, for the job log. */
  reason?: string;
  /** Navigation/renderer trouble seen while loading (page crash, failed request). */
  navError?: string;
  /** Title of the final page: tells a real app apart from a blank or crashed tab. */
  pageTitle?: string;
  /** data: URI screenshot of the final page, so a headless-only failure is visible. */
  screenshot?: string;
  /** One line per exit tried, for the job log. */
  trace?: string[];
};

/**
 * Browser state belonging to one job run rather than one attempt. A retry that offered
 * the same refused exits again would just replay the same refusals, so the exits are
 * remembered per host across every attempt of the run, and a budget started by an action
 * keeps running for its retries instead of restarting with each one.
 */
export type CfRunState = {
  /** Exits already refused, keyed by host. The accepted one is never in here. */
  refused: Map<string, Set<string>>;
  /** Deadlines the caller has started, keyed however the caller likes. */
  deadlines: Map<string, number>;
};

export function newCfRunState(): CfRunState {
  return { refused: new Map(), deadlines: new Map() };
}

/** The refused-exit set for `host`, created on first use. */
export function cfRefusedFor(state: CfRunState, host: string): Set<string> {
  const key = host || "*";
  let set = state.refused.get(key);
  if (!set) {
    set = new Set();
    state.refused.set(key, set);
  }
  return set;
}

export type LoadOptions = {
  /**
   * The URL is a signed Telegram Mini App URL: stub the webview bridge the app
   * expects, and press its checkin control once the page is up.
   */
  miniApp?: boolean;
  /**
   * Steps to run inside the Mini App, in order. Each entry is the visible text of a
   * control to press, or a placeholder that answers a question the app asks:
   * `{input}` solves an arithmetic captcha locally, `{aiInput}` hands the question to
   * `solveQuestion`. Empty or omitted falls back to a checkin-worded control.
   */
  inAppClicks?: string[];
  /** Answers a question read off the app (used by the `{aiInput}` step). */
  solveQuestion?: (question: string) => Promise<string>;
  /**
   * Exits to try, in order, when a challenge is refused. Cloudflare accepts some IPs and
   * not others, so a single proxy is often not enough.
   */
  proxyCandidates?: ProxyCandidate[];
  /** Re-mints the URL between attempts (signed Mini App init data ages). */
  refreshUrl?: () => Promise<string>;
  /**
   * Budget for the whole load, across every exit tried. Each internal wait is
   * clamped to what is left of it, so the step cannot run on indefinitely.
   * Defaults to DEFAULT_BUDGET_MS.
   */
  maxWaitMs?: number;
  /** Keep a screenshot of the final page on the result (diagnostics). */
  screenshot?: boolean;
};

const NAV_TIMEOUT_MS = 45_000;
const CHALLENGE_TIMEOUT_MS = 45_000;
const POLL_MS = 1_000;
// Let a post-challenge redirect/render settle before scraping text.
const SETTLE_MS = 1_500;
// Let the Mini App's checkin request round-trip before scraping its result text.
const IN_APP_SETTLE_MS = 4_000;
// Between in-app steps: enough for a dialog to be raised or a list to re-render.
const IN_APP_STEP_MS = 1_200;
// After a widget challenge: how long to wait for the site to confirm the outcome.
const CONFIRM_TIMEOUT_MS = 20_000;
// A Mini App is a single-page app: give it time to boot before judging the page.
const APP_READY_TIMEOUT_MS = 25_000;
const READY_POLL_MS = 500;
// Whole-load budget when the caller sets none: enough for a few exits to be tried.
const DEFAULT_BUDGET_MS = 300_000;
// Below this there is no point starting another exit.
const MIN_ATTEMPT_MS = 10_000;
// A page holding less text than this rendered nothing worth reading.
const BLANK_TEXT_LEN = 10;
// How long to keep looking for a verification the app raises after the checkin click.
const POST_CLICK_CHALLENGE_MS = 20_000;
// Ceiling for a single CDP call. Puppeteer's own default is three minutes, long enough
// for one wedged call to spend a whole step's budget.
const PROTOCOL_TIMEOUT_MS = 30_000;

/**
 * Decides whether a Mini App pass actually did anything. A page that rendered nothing,
 * or one where the step the caller asked for was never carried out, is a failure even
 * though no challenge stood in the way -- reporting it as success logs a checkin that
 * never happened.
 */
export function miniAppVerdict(state: {
  /** A Cloudflare challenge was seen (and, per `solved`, how it went). */
  challenged: boolean;
  /** Verdict so far: the challenge cleared, or there was none. */
  solved: boolean;
  /** Visible text of the final page. */
  text: string;
  /** In-app steps that were carried out, if any. */
  inAppAction?: string;
  /** Why the in-app steps stopped short, if they did. */
  inAppFailure?: string;
  /** Navigation or renderer trouble seen on the way. */
  navError?: string;
}): { ok: boolean; reason?: string } {
  const { challenged, solved, text, inAppAction, inAppFailure, navError } = state;

  if (!challenged && text.trim().length < BLANK_TEXT_LEN && !inAppAction) {
    return {
      ok: false,
      reason: navError
        ? `the app page never rendered (${navError})`
        : "the app page came up blank -- the browser reached no readable content",
    };
  }
  if (solved && inAppFailure) return { ok: false, reason: inAppFailure };
  // The app's own wording wins over our reading of the page: if it is still asking to be
  // verified, the checkin did not go through, whatever the challenge detection saw.
  if (solved && VERIFY_REQUIRED_RE.test(text)) {
    return {
      ok: false,
      reason:
        "the app is still asking for a human verification, so the checkin did not go " +
        "through -- add the verification step to the action (its control, or css:...)",
    };
  }
  if (!solved) {
    return {
      ok: false,
      reason: challenged
        ? 'Could not pass the Cloudflare "I am not a bot" challenge'
        : (navError ?? "the app page could not be loaded"),
    };
  }
  return { ok: true };
}

/** Millis left before `deadline`, never negative. */
function msLeft(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

/** `ms`, cut down to what is left of the budget. */
function capped(ms: number, deadline: number): number {
  return Math.min(ms, msLeft(deadline));
}

/** Sleeps `ms`, or until the budget runs out. */
function sleep(ms: number, deadline?: number): Promise<void> {
  const wait = deadline ? capped(ms, deadline) : ms;
  return new Promise((r) => setTimeout(r, Math.max(0, wait)));
}

// Builds the http(s)/socks proxy option puppeteer-real-browser expects.
function proxyOption(proxyUrl?: string): { host: string; port: number; username?: string; password?: string } | undefined {
  if (!proxyUrl) return undefined;
  try {
    const u = new URL(proxyUrl);
    if (!u.port) return undefined;
    return {
      host: u.hostname,
      port: Number(u.port),
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch {
    return undefined;
  }
}

type SocksBridge = { port: number; close: () => void };

/**
 * Chromium cannot use a SOCKS5 proxy that needs credentials: --proxy-server takes no
 * password and its auth prompt only answers HTTP 407. Bemby's proxies are exactly that
 * (socks5://user:pass@host:port), so when one is configured for Cloudflare solving we
 * put a loopback HTTP proxy in front of it for the browser's lifetime and point the
 * browser at that. Only CONNECT is handled -- challenge pages are https.
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

// Launches a real (rebrowser-patched) Chromium via puppeteer-real-browser: headed
// under an auto-managed Xvfb display with a real cursor, and turnstile:true so it
// auto-clicks Cloudflare Turnstile. This is the realistic path to pass Turnstile.
// The profile is kept per exit so its cookies (cf_clearance included) carry over, and
// the browser's language is set to match where that exit comes out.
async function launchBrowser(proxyUrl?: string): Promise<{
  browser: Browser;
  page: Page;
  cleanup: () => void;
  /** Stable id of the exit this browser goes out through. */
  key: string;
  /** What is known about where it comes out, if anything yet. */
  geo?: CfExitGeo;
}> {
  const executablePath = chromiumExecutable();
  if (!executablePath) {
    throw new Error(
      "Chromium not installed. Enable Cloudflare solving in Settings to install it into the data dir.",
    );
  }

  // A data-dir (alt-root) install keeps its shared libs and fonts inside the root.
  // Set these on our own env (not customConfig.envVars, which would REPLACE the
  // environment and clobber the DISPLAY puppeteer-real-browser sets for Xvfb);
  // the Chromium child inherits both from us.
  if (executablePath.startsWith(cfChromiumRoot())) {
    const root = cfChromiumRoot();
    // usr/lib/pulseaudio holds libpulsecommon-*.so, a private dep of libpulse.so.0
    // that Chromium NEEDs; without it on the path the musl loader aborts (exit 127)
    // before the DevTools port opens, surfacing to puppeteer as ECONNREFUSED.
    process.env.LD_LIBRARY_PATH = [
      `${root}/usr/lib`,
      `${root}/lib`,
      `${root}/usr/lib/chromium`,
      `${root}/usr/lib/pulseaudio`,
      process.env.LD_LIBRARY_PATH,
    ]
      .filter(Boolean)
      .join(":");
    process.env.FONTCONFIG_PATH = `${root}/etc/fonts`;
    ensureAltRootFonts(root);
  }

  // A SOCKS proxy is reached through a loopback HTTP bridge (Chromium cannot
  // authenticate to SOCKS itself); http(s) proxies are passed straight through.
  let bridge: SocksBridge | undefined;
  let proxy = proxyOption(proxyUrl);
  if (proxyUrl && /^socks/i.test(proxyUrl)) {
    try {
      bridge = await startSocksBridge(new URL(proxyUrl));
      proxy = { host: "127.0.0.1", port: bridge.port };
    } catch (err: any) {
      console.error(`[cloudflare] SOCKS bridge failed: ${err?.message ?? err}`);
      bridge = undefined;
      proxy = undefined;
    }
  }

  const key = exitKey(proxyUrl);
  const geo = cfExitGeo(key);
  const profile = claimProfile(key);

  try {
    const launched = await connect({
      headless: false,
      turnstile: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--window-size=1280,800",
        // A profile that is reused must not reopen the last session or offer to restore
        // a crashed one, either of which would leave a dialog over the page
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-crash-restore-bubble",
        // A window Chromium considers occluded gets its timers, rendering and observer
        // callbacks throttled, which stalls anything waiting on them. Separate switches
        // on purpose: a second --disable-features would override the one
        // puppeteer-real-browser sets for AutomationControlled.
        "--window-position=0,0",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        // Language has to be set at launch to stay consistent: this covers both
        // navigator.language(s) and the Accept-Language header
        ...(geo?.lang ? [`--lang=${geo.lang}`, `--accept-lang=${geo.lang}`] : []),
      ],
      customConfig: {
        chromePath: executablePath,
        ...(profile.dir ? { userDataDir: profile.dir } : {}),
      },
      // A CDP call against a wedged renderer otherwise waits out puppeteer's 3-minute
      // default, which would swallow the whole step budget in one call
      connectOption: { protocolTimeout: PROTOCOL_TIMEOUT_MS },
      proxy,
    });
    // A reused profile reopens the tabs the last session left behind, and they pile up
    // run after run. Worse, the restored tab -- not ours -- is the active one, and
    // Chromium delivers pointer presses only to the active tab: a click then registers as
    // a hover and nothing else. Close the strays and bring ours to the front.
    const strays = (await launched.browser.pages().catch(() => [])).filter(
      (p) => p !== launched.page,
    );
    for (const stray of strays) await stray.close().catch(() => {});
    if (strays.length) {
      console.log(`[cloudflare] closed ${strays.length} restored tab(s) from the saved profile`);
    }
    await launched.page.bringToFront().catch(() => {});

    return {
      ...launched,
      key,
      geo,
      cleanup: () => {
        bridge?.close();
        profile.release();
      },
    };
  } catch (err) {
    bridge?.close();
    profile.release();
    throw err;
  }
}

/**
 * Asks Cloudflare where this exit comes out and applies the matching clock, so the
 * browser's timezone lines up with its IP. Looked up once per exit and remembered; the
 * language it implies is applied from the next launch, which is where it has to be set.
 */
async function alignWithExit(
  page: Page,
  key: string,
  known: CfExitGeo | undefined,
  deadline: number,
): Promise<CfExitGeo | undefined> {
  let geo = known;
  if (!geo) {
    try {
      await page.goto(TRACE_URL, {
        waitUntil: "domcontentloaded",
        timeout: Math.max(5_000, capped(15_000, deadline)),
      });
      const body = await page.evaluate(() => document.body?.innerText ?? "");
      const loc = /(?:^|\n)loc=([A-Z]{2})/.exec(body)?.[1];
      if (loc) {
        geo = { loc, ...(COUNTRY_LOCALE[loc] ?? {}) };
        rememberCfExitGeo(key, geo);
        console.log(
          `[cloudflare] exit ${key} comes out in ${loc}` +
            (geo.tz ? ` -- using ${geo.tz} / ${geo.lang}` : " -- no locale mapped"),
        );
      }
    } catch (err: any) {
      console.warn(`[cloudflare] exit lookup failed: ${err?.message ?? err}`);
    }
  }
  if (geo?.tz) await page.emulateTimezone(geo.tz).catch(() => {});
  return geo;
}

/**
 * Clicks an element by moving the pointer to it, rather than through `page.click`.
 *
 * Puppeteer's own click first awaits `scrollIntoViewIfNeeded`, which resolves off an
 * IntersectionObserver callback. Under Xvfb, with a window Chromium believes is occluded,
 * those callbacks are throttled and never arrive: the CDP call then hangs until the
 * protocol timeout and the step reports a press that never happened. Scrolling
 * synchronously in the page and dispatching real pointer events avoids the wait entirely,
 * and is closer to what a person does anyway.
 */
async function clickElement(page: Page, selector: string): Promise<boolean> {
  const box = await page
    .evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, selector)
    .catch(() => null);
  if (!box) return false;
  // Approach then press, as a pointer would
  let failure: string | undefined;
  await page.mouse.move(box.x - 8, box.y + 6).catch((err: any) => {
    failure = `move: ${err?.message ?? err}`;
  });
  await page.mouse.click(box.x, box.y).catch((err: any) => {
    failure = `click: ${err?.message ?? err}`;
  });
  if (failure) {
    console.warn(`[cloudflare] pointer ${failure}`);
    return false;
  }
  return true;
}

// Full-page Cloudflare interstitial ("Just a moment...").
async function isInterstitial(page: Page): Promise<boolean> {
  const title = (await page.title().catch(() => "")) || "";
  if (/just a moment|checking your browser|attention required|请稍候|正在验证/i.test(title)) return true;
  return page
    .evaluate(() => !!document.querySelector("#challenge-form, #challenge-running"))
    .catch(() => false);
}

// Turnstile renders into a shadow root when a site calls turnstile.render() itself, and
// document.querySelector cannot see inside one -- so every widget lookup walks shadow
// roots as well, or an app's challenge looks absent while it sits there unsolved.
const DEEP_QUERY_FN = `
  function __deepQuery(selector) {
    var out = [];
    (function walk(root) {
      out.push.apply(out, Array.prototype.slice.call(root.querySelectorAll(selector)));
      Array.prototype.forEach.call(root.querySelectorAll('*'), function (el) {
        if (el.shadowRoot) walk(el.shadowRoot);
      });
    })(document);
    return out;
  }
`;

/**
 * An interactive Turnstile challenge is on the page. The response field is the reliable
 * marker: Turnstile creates it for every widget, including ones rendered explicitly into
 * the site's own element, whose iframe then lives in a closed shadow root that no
 * selector can reach.
 */
async function hasTurnstileWidget(page: Page): Promise<boolean> {
  return page
    .evaluate(
      `(function () { ${DEEP_QUERY_FN}
         return __deepQuery(".cf-turnstile, iframe[src*='challenges.cloudflare.com'], [name='cf-turnstile-response']").length > 0;
       })()`,
    )
    .then((v) => !!v)
    .catch(() => false);
}

/** The Turnstile script is loaded, so a widget may still be rendered later. */
async function hasTurnstileScript(page: Page): Promise<boolean> {
  return page
    .evaluate(
      () => !!document.querySelector("script[src*='challenges.cloudflare.com/turnstile']"),
    )
    .catch(() => false);
}

// Either form counts when deciding whether a page is challenge-gated at all.
async function hasTurnstile(page: Page): Promise<boolean> {
  return (await hasTurnstileWidget(page)) || (await hasTurnstileScript(page));
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * Locates the Turnstile widget's iframe through CDP with `pierce`, the only way to see
 * an element inside the closed shadow root Turnstile renders into. Returns its
 * on-screen box.
 */
async function turnstileBoxViaCdp(page: Page): Promise<Box | null> {
  let session: any;
  try {
    session = await (page as any).target().createCDPSession();
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });

    let nodeId: number | null = null;
    const walk = (node: any) => {
      if (nodeId) return;
      if (node.nodeName === "IFRAME") {
        const attrs: string[] = node.attributes ?? [];
        for (let i = 0; i < attrs.length; i += 2) {
          if (attrs[i] === "src" && /challenges\.cloudflare\.com/.test(attrs[i + 1] ?? "")) {
            nodeId = node.nodeId;
            return;
          }
        }
      }
      for (const child of node.children ?? []) walk(child);
      for (const shadow of node.shadowRoots ?? []) walk(shadow);
      if (node.contentDocument) walk(node.contentDocument);
    };
    walk(root);
    if (!nodeId) return null;

    const { model } = await session.send("DOM.getBoxModel", { nodeId });
    const border = model.border as number[]; // x1,y1,x2,y2,x3,y3,x4,y4
    return {
      x: border[0],
      y: border[1],
      width: border[2] - border[0],
      height: border[5] - border[1],
    };
  } catch {
    return null;
  } finally {
    await session?.detach?.().catch(() => {});
  }
}

/**
 * Clicks an embedded Turnstile widget's checkbox with a real mouse click at its left
 * edge, where the checkbox sits.
 *
 * puppeteer-real-browser's own auto-clicker aims at the parent element of the response
 * field, which for an explicitly rendered widget is a wrapper holding nothing but a
 * hidden input -- a zero-sized box, so its click lands nowhere and the challenge waits
 * forever. Hence the CDP lookup, with the widget's sized ancestor as a fallback.
 */
export async function clickTurnstileWidget(page: Page): Promise<boolean> {
  let box = await turnstileBoxViaCdp(page);

  if (!box || box.width < 20) {
    box = (await page
      .evaluate(
        `(function () { ${DEEP_QUERY_FN}
           var el = __deepQuery("iframe[src*='challenges.cloudflare.com'], .cf-turnstile, [name='cf-turnstile-response']")[0];
           if (!el) return null;
           // Climb to something actually laid out: the widget's own slot in the page
           var node = el;
           for (var i = 0; node && i < 4; i++, node = node.parentElement) {
             var r = node.getBoundingClientRect();
             if (r.width >= 200 && r.height >= 30) {
               node.scrollIntoView({ block: 'center' });
               r = node.getBoundingClientRect();
               return { x: r.x, y: r.y, width: r.width, height: r.height };
             }
           }
           return null;
         })()`,
      )
      .catch(() => null)) as Box | null;
  }
  if (!box || box.width < 20) return false;

  // Approach the checkbox like a pointer would, then click it
  await page.mouse.move(box.x + 12, box.y + box.height / 2 + 8).catch(() => {});
  await page.mouse.click(box.x + 30, box.y + box.height / 2).catch(() => {});
  return true;
}

// A solved Turnstile fills its hidden response field with a token; the widget API is
// asked as well, since a site can render the widget somewhere this cannot reach.
export async function turnstileToken(page: Page): Promise<string> {
  return page
    .evaluate(
      `(function () { ${DEEP_QUERY_FN}
         var el = __deepQuery("[name='cf-turnstile-response']")[0];
         if (el && el.value) return el.value;
         try { return window.turnstile && window.turnstile.getResponse ? (window.turnstile.getResponse() || '') : ''; }
         catch (e) { return ''; }
       })()`,
    )
    .then((v) => (typeof v === "string" ? v : ""))
    .catch(() => "");
}

// Text a page shows when the challenge was refused outright. Recognising it ends the
// attempt at once instead of waiting out the timeout, so the next exit can be tried.
const REFUSED_RE =
  /人机验证失败|人機驗證失敗|验证失败|驗證失敗|verification failed|challenge failed|请刷新页面重试|請刷新頁面重試/i;

// An app asking for a human check in its own wording, typically in a dialog raised by
// pressing the checkin control. The widget behind it renders a moment later, so this is
// also the signal to keep waiting for one.
const VERIFY_REQUIRED_RE =
  /请完成人机验证|請完成人機驗證|完成人机验证|完成人機驗證|需要人机验证|需要人機驗證|complete the (?:human )?verification|verify you are human/i;

// Text a verify portal shows once the identity check has gone through.
const SUCCESS_RE =
  /success|verified|verification complete|completed|已(驗|验)[證证]|(驗|验)[證证](成功|完成|通過|通过)|已通過|已通过/i;

// Some verify portals only engage Turnstile after the user clicks a button. A
// real (CDP) click is required -- Turnstile ignores untrusted element.click()
// events. Generic: prefer a button whose label reads like a verify/continue
// action, otherwise fall back to the sole visible button (these portals almost
// always have exactly one), so it isn't tied to any one site's wording. Nothing is
// clicked on a page full of unrelated controls (e.g. a Mini App panel with a nav
// sidebar), where guessing would navigate away from the challenge.
async function clickVerifyButton(page: Page): Promise<boolean> {
  const sel = await page
    .evaluate(() => {
      const all = Array.from(
        document.querySelectorAll("button,a[href],[role=button],input[type=submit],input[type=button]"),
      ) as HTMLElement[];
      const visible = all.filter((e) => e.offsetParent !== null || e.getClientRects().length > 0);
      const byText = visible.find((e) =>
        /verify|驗證|验证|continue|submit|確認|确认|start|begin|開始|开始|proceed/i.test(
          e.textContent || (e as HTMLInputElement).value || "",
        ),
      );
      const target = byText ?? (visible.length === 1 ? visible[0] : null);
      if (!target) return null;
      target.setAttribute("data-cf-click", "1");
      return "[data-cf-click='1']";
    })
    .catch(() => null);
  if (!sel) return false;
  return clickElement(page, sel);
}


// Cap (capjs.js.org) is a self-hosted proof-of-work captcha some apps use instead of
// Turnstile: a checkbox reading "Verify you're human" inside a custom element's shadow
// root. Ticking it runs the work in the browser and the app proceeds on its own once a
// token is issued, so it needs no service and no key -- only a real click and patience.
const CAP_SELECTOR = "cap-widget,cap-floating-widget,[data-cap-api-endpoint]";
const CAP_ASKING_RE = /verify you'?re human|i'?m not a robot|请完成验证/i;
const CAP_SOLVED_RE = /you'?re human|verified|完成|成功/i;

/** A Cap widget is on the page (light DOM or inside a shadow root). */
async function hasCapWidget(page: Page): Promise<boolean> {
  return page
    .evaluate(
      `(function () { ${DEEP_QUERY_FN}
         return __deepQuery(${JSON.stringify(CAP_SELECTOR)}).length > 0;
       })()`,
    )
    .then((v) => !!v)
    .catch(() => false);
}

/** What the Cap widget is showing, and whether it has produced a token. */
async function capState(page: Page): Promise<{ asking: boolean; solved: boolean }> {
  return page
    .evaluate(
      `(function () { ${DEEP_QUERY_FN}
         var w = __deepQuery(${JSON.stringify(CAP_SELECTOR)})[0];
         if (!w) return { asking: false, solved: false };
         var root = w.shadowRoot || w;
         var text = (root.textContent || "") + " " + (w.textContent || "");
         var token = w.getAttribute("data-cap-token") || w.getAttribute("token") || "";
         if (!token) {
           var field = (root.querySelector ? root.querySelector("input") : null);
           token = (field && field.value) || "";
         }
         return {
           asking: ${CAP_ASKING_RE.toString()}.test(text),
           solved: !!token || (${CAP_SOLVED_RE.toString()}.test(text) && !${CAP_ASKING_RE.toString()}.test(text)),
         };
       })()`,
    )
    .then((v: any) => ({ asking: !!v?.asking, solved: !!v?.solved }))
    .catch(() => ({ asking: false, solved: false }));
}

/** Ticks the Cap checkbox: a real pointer press at its box, shadow root and all. */
async function clickCapWidget(page: Page): Promise<boolean> {
  const box = (await page
    .evaluate(
      `(function () { ${DEEP_QUERY_FN}
         var w = __deepQuery(${JSON.stringify(CAP_SELECTOR)})[0];
         if (!w) return null;
         w.scrollIntoView({ block: "center" });
         var r = w.getBoundingClientRect();
         if (r.width < 10 || r.height < 10) return null;
         return { x: r.x, y: r.y, width: r.width, height: r.height };
       })()`,
    )
    .catch(() => null)) as Box | null;
  if (!box) return false;
  // The checkbox sits at the left edge, as it does in Turnstile
  await page.mouse.move(box.x + 12, box.y + box.height / 2 + 6).catch(() => {});
  await page.mouse.click(box.x + 22, box.y + box.height / 2).catch(() => {});
  return true;
}

/**
 * Ticks a Cap checkbox and waits for the app to move on. The work happens in the browser
 * and takes a moment; the app is what completes the action once its token arrives, so the
 * app's own success wording counts as much as the widget's state.
 */
async function solveCap(page: Page, deadline: number): Promise<boolean> {
  if (!(await clickCapWidget(page))) return false;
  let clicks = 1;
  while (Date.now() < deadline) {
    await sleep(POLL_MS, deadline);
    const state = await capState(page);
    const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (state.solved || SUCCESS_RE.test(body)) return true;
    if (REFUSED_RE.test(body)) return false;
    // Gone from the page altogether: the app took it and closed the dialog
    if (!state.asking && !VERIFY_REQUIRED_RE.test(body)) return true;
    // Nudge it a couple of times in case the first press missed the checkbox
    if (state.asking && clicks < 3 && Date.now() > deadline - CHALLENGE_TIMEOUT_MS + clicks * 8_000) {
      clicks++;
      await clickCapWidget(page);
    }
  }
  return false;
}

// telegram-web-app.js posts events to the host client; with no host it either
// throws or silently drops them, and apps that call WebApp.ready() first then break.
// This stub is what a Telegram Android/iOS webview exposes, so the bridge works and
// the signed initData in the URL fragment is picked up as normal.
const WEBVIEW_PROXY_SHIM = `
  window.TelegramWebviewProxy = window.TelegramWebviewProxy || {
    postEvent: function (type, data) {
      try { window.dispatchEvent(new CustomEvent('tg-post', { detail: { type: type, data: data } })); } catch (e) {}
    },
  };
`;

// Labels that clearly mean "check in", and the states that mean it is already done.
// Deliberately narrow: only a control carrying such a label is pressed, so nothing
// else in the app (points spending, lotteries) can be triggered.
const IN_APP_LABEL_RE = /签到|簽到|打卡|领取|領取|check\s?-?in|sign\s?-?in/i;
const IN_APP_DONE_RE = /已签到|已簽到|已打卡|已领取|已領取|已完成|already/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LOADING_RE = /loading|加载|加載|載入|please wait|请稍候|請稍候/i;

/**
 * Waits for a single-page app to finish booting: a Mini App served straight from
 * `goto` is usually still a spinner, and judging the page then sees neither the
 * challenge it is about to render nor the controls to press. Returns as soon as a
 * challenge shows up, or once the rendered text has stopped changing.
 */
async function waitForAppReady(page: Page, budgetDeadline: number): Promise<void> {
  const deadline = Math.min(Date.now() + APP_READY_TIMEOUT_MS, budgetDeadline);
  let previous = "";
  while (Date.now() < deadline) {
    if ((await hasTurnstile(page)) || (await isInterstitial(page))) return;
    const text = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).trim();
    const booting = !text || text.length < 40 || LOADING_RE.test(text);
    if (!booting && text === previous) return;
    previous = text;
    await sleep(READY_POLL_MS, deadline);
  }
}

/** How the thing that got clicked was identified, worst last. */
type InAppTargetKind = "selector" | "control" | "pointer" | "in-card" | "text";

type InAppTarget = { label: string; kind: InAppTargetKind; done: boolean };

/**
 * Finds the control to press inside the Mini App.
 *
 * A label is not a control. These apps put the wording in several places at once -- a
 * card captioned "每日签到" over a heading "立即签到" beside a button reading "签到" -- and
 * taking the first match in document order lands on the caption, which clicks nothing
 * while looking like success. So every match is collected and the most control-like one
 * wins: a real button or link first, then an element that at least behaves like one, then
 * a button sitting in the same card as the label, and only then the bare text.
 *
 * `wanted` may instead be a CSS selector (`css:` prefix), which skips all of this and
 * presses exactly what the selector names.
 */
async function findInAppCheckin(
  page: Page,
  labelRe: RegExp,
  selector?: string,
): Promise<InAppTarget | null> {
  return page
    .evaluate(
      (labelSrc: string, doneSrc: string, sel: string) => {
        const label = new RegExp(labelSrc, "i");
        const done = new RegExp(doneSrc, "i");
        const CONTROL_SEL = "button,[role=button],a[href],input[type=submit],input[type=button]";

        const visible = (el: Element) =>
          (el as HTMLElement).offsetParent !== null || el.getClientRects().length > 0;

        const spent = (el: Element) =>
          (el as HTMLButtonElement).disabled ||
          el.getAttribute("aria-disabled") === "true" ||
          el.closest("[disabled],[aria-disabled='true']") !== null;

        const describe = (el: Element, fallback: string) =>
          ((el.textContent ?? "").trim() || (el as HTMLInputElement).value || fallback).slice(0, 40);

        const take = (el: Element, kind: string, fallbackLabel: string) => {
          if (spent(el) || done.test(describe(el, ""))) {
            return { label: describe(el, fallbackLabel), kind: kind, done: true };
          }
          el.setAttribute("data-cf-checkin", "1");
          return { label: describe(el, fallbackLabel), kind: kind, done: false };
        };

        // An explicit selector is taken at its word: first visible match.
        if (sel) {
          const hit = Array.from(document.querySelectorAll(sel)).find(visible);
          return hit ? take(hit, "selector", sel) : null;
        }

        // Direct text nodes only, so the element holding the label is found rather than
        // every wrapper around it.
        const ownText = (el: Element) =>
          Array.from(el.childNodes)
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent ?? "")
            .join("")
            .trim();

        // Ranked candidates for one labelled element: the real control it sits in, an
        // ancestor that behaves like one, a control inside the same card, or the text.
        const candidatesFor = (el: Element): Array<{ el: Element; kind: string }> => {
          const out: Array<{ el: Element; kind: string }> = [];
          const semantic = el.closest(CONTROL_SEL);
          if (semantic && visible(semantic)) out.push({ el: semantic, kind: "control" });

          let node: Element | null = el;
          for (let i = 0; node && i < 3; i++, node = node.parentElement) {
            if (getComputedStyle(node as HTMLElement).cursor === "pointer") {
              out.push({ el: node, kind: "pointer" });
              break;
            }
          }

          // The label captions a card; the button that acts on it lives in that card.
          let box: Element | null = el;
          for (let i = 0; box && i < 4; i++, box = box.parentElement) {
            const inside = Array.from(box.querySelectorAll(CONTROL_SEL)).filter(
              (c) => visible(c) && label.test((c.textContent ?? "") || (c as HTMLInputElement).value || ""),
            );
            if (inside.length) {
              out.push({ el: inside[0], kind: "in-card" });
              break;
            }
          }

          out.push({ el, kind: "text" });
          return out;
        };

        const RANK = ["control", "pointer", "in-card", "text"];
        let best: { el: Element; kind: string; fallback: string } | null = null;

        for (const el of Array.from(document.querySelectorAll("*"))) {
          const text = (ownText(el) || (el as HTMLInputElement).value || "").trim();
          if (!text || text.length > 30 || !label.test(text)) continue;
          if (!visible(el)) continue;

          for (const cand of candidatesFor(el)) {
            if (!best || RANK.indexOf(cand.kind) < RANK.indexOf(best.kind)) {
              best = { el: cand.el, kind: cand.kind, fallback: text };
            }
            break; // only this element's best candidate competes
          }
          // A real control is as good as it gets; no need to look further
          if (best && best.kind === "control") break;
        }

        return best ? take(best.el, best.kind, best.fallback) : null;
      },
      labelRe.source,
      IN_APP_DONE_RE.source,
      selector ?? "",
    )
    .catch((err: any) => {
      // Swallowing this once cost a long hunt: a lookup that throws looks exactly like
      // an app with no checkin control on it.
      console.warn(`[cloudflare] in-app lookup failed: ${err?.message ?? err}`);
      return null;
    }) as Promise<InAppTarget | null>;
}

/** `css:<selector>` in a step names the element to press outright. */
function parseSelectorStep(step: string): string | undefined {
  const m = /^css:(.+)$/i.exec(step.trim());
  return m ? m[1].trim() : undefined;
}

type ClickOutcome = {
  /** What to show in the log. */
  outcome: string;
  /** The app said this action is already spent. */
  done: boolean;
  /** Nothing control-like was pressed, so the click may well have done nothing. */
  weak: boolean;
};

/**
 * Presses one control inside the Mini App: the one named by `wanted` (a label, or a
 * `css:` selector), or a checkin-worded one when nothing is given. Returns what happened,
 * or undefined when the label is nowhere on the page.
 */
async function clickInAppControl(
  page: Page,
  wanted?: string,
): Promise<ClickOutcome | undefined> {
  const selector = wanted ? parseSelectorStep(wanted) : undefined;
  const labelRe = wanted && !selector ? new RegExp(escapeRe(wanted), "i") : IN_APP_LABEL_RE;

  const target = await findInAppCheckin(page, labelRe, selector);
  if (target?.done) {
    return { outcome: `already done: ${target.label}`, done: true, weak: false };
  }

  // Nothing control-like matched. Before pressing inert text -- or giving up -- see
  // whether the app is saying the action is already spent: a checkin done earlier today
  // takes its button away but leaves the wording ("每日签到 … 今日已签到") behind, which
  // still matches the label the job names.
  if (!selector && (!target || target.kind === "text")) {
    const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (IN_APP_DONE_RE.test(text) && (labelRe.test(text) || IN_APP_LABEL_RE.test(text))) {
      return { outcome: "already done (from the page's own wording)", done: true, weak: false };
    }
  }

  if (target) {
    // Real (CDP) click: mini apps commonly bind pointer events, not synthetic clicks
    const landed = await clickElement(page, "[data-cf-checkin='1']");
    await page.evaluate(() =>
      document.querySelector("[data-cf-checkin]")?.removeAttribute("data-cf-checkin"),
    ).catch(() => {});
    if (!landed) {
      console.warn("[cloudflare] in-app click did not land: the control has no on-screen box");
      return { outcome: `${target.label} (could not be clicked)`, done: false, weak: true };
    }
    // "text" means the label itself was clicked for want of anything better, which for
    // an app that binds its handler to a button does nothing at all -- say so.
    const weak = target.kind === "text";
    return {
      outcome: weak ? `${target.label} (plain text, not a control)` : target.label,
      done: false,
      weak,
    };
  }

  return undefined;
}

// Text of the dialog the app is showing, or the whole page when there is none: the
// question to answer is almost always inside a modal raised by the previous step.
async function inAppQuestion(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const dialogs = Array.from(
        document.querySelectorAll("[role=dialog],dialog,[class*='dialog'],[class*='modal']"),
      ) as HTMLElement[];
      const open = dialogs.filter((d) => d.offsetParent !== null || d.getClientRects().length > 0);
      // Innermost open dialog holds the prompt; outer ones are just backdrops
      const inner = open.length ? open[open.length - 1] : null;
      return (inner?.innerText ?? document.body?.innerText ?? "").trim();
    })
    .catch(() => "");
}

/** Solves the arithmetic captchas mini apps use ("5 + 3 = ?"). */
export function solveArithmetic(text: string): string | undefined {
  const m = text.match(/(-?\d+)\s*([+\-*x×÷/])\s*(-?\d+)\s*(?:=\s*[?？]?|[?？])/);
  if (!m) return undefined;
  const a = Number(m[1]);
  const b = Number(m[3]);
  switch (m[2]) {
    case "+": return String(a + b);
    case "-": return String(a - b);
    case "*": case "x": case "×": return String(a * b);
    default: return b === 0 ? undefined : String(a / b);
  }
}

// Types an answer into the app's visible input, preferring one inside the open dialog.
async function fillInAppAnswer(page: Page, answer: string): Promise<boolean> {
  const ok = await page
    .evaluate(() => {
      const fields = Array.from(
        document.querySelectorAll("input:not([type=hidden]),textarea"),
      ) as HTMLInputElement[];
      const usable = fields.filter(
        (f) =>
          !f.disabled &&
          !f.readOnly &&
          !["checkbox", "radio", "submit", "button"].includes(f.type) &&
          (f.offsetParent !== null || f.getClientRects().length > 0),
      );
      // The last visible field is the one the newest dialog raised
      const target = usable.filter((f) => !f.value).pop() ?? usable.pop();
      if (!target) return false;
      target.setAttribute("data-cf-input", "1");
      return true;
    })
    .catch(() => false);
  if (!ok) return false;
  await clickElement(page, "[data-cf-input='1']");
  await page.type("[data-cf-input='1']", answer, { delay: 60 }).catch(() => {});
  await page
    .evaluate(() => document.querySelector("[data-cf-input]")?.removeAttribute("data-cf-input"))
    .catch(() => {});
  return true;
}

/**
 * Runs the configured in-app steps in order, letting the app settle between them so
 * each step can render what the next one needs (press checkin, answer its captcha,
 * confirm). Stops at the first step that cannot be carried out, and reports how far
 * it got. `ok` is false when a step the caller asked for could not be carried out,
 * so a page where nothing was pressed is not mistaken for a completed checkin.
 */
async function runInAppClicks(
  page: Page,
  steps: string[],
  deadline: number,
  solveQuestion?: (question: string) => Promise<string>,
): Promise<{ trace?: string; ok: boolean; failure?: string }> {
  const done: string[] = [];
  let failure: string | undefined;

  for (const step of steps.length ? steps : [undefined]) {
    if (msLeft(deadline) <= 0) {
      failure = "ran out of time before the in-app steps finished";
      break;
    }
    if (step === "{input}" || step === "{aiInput}") {
      const question = await inAppQuestion(page);
      let answer: string | undefined;
      if (step === "{input}") {
        answer = solveArithmetic(question);
      } else if (solveQuestion) {
        answer = (await solveQuestion(question).catch(() => undefined))?.trim();
      }
      if (!answer) {
        done.push(`${step} unanswered`);
        failure = `${step} could not be answered`;
        break;
      }
      if (!(await fillInAppAnswer(page, answer))) {
        done.push(`${step} has no field to fill`);
        failure = `${step} found no input to fill`;
        break;
      }
      done.push(`${step}="${answer}"`);
      await sleep(IN_APP_STEP_MS, deadline);
      continue;
    }

    // What the page reads now, so a click on something inert can be told from a real one
    const before = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    const click = await clickInAppControl(page, step);
    if (!click) {
      // A label that never appears is worth reporting: the app may have changed
      if (step) done.push(`"${step}" not found`);
      failure = step
        ? `"${step}" is not on the app page`
        : "no checkin control was found in the app";
      break;
    }
    done.push(click.outcome);
    await sleep(IN_APP_STEP_MS, deadline);

    // Pressing plain text is a guess. If the app did not react to it, nothing happened,
    // and reporting success would log a checkin that was never made.
    if (click.weak) {
      const after = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (after === before) {
        failure =
          `pressed "${click.outcome}" but it is not a control and the app did not react` +
          " -- name the control exactly, or give a CSS selector (css:...)";
        break;
      }
    }
    if (click.done) break;
  }

  // Let the last step's request round-trip before the page text is scraped
  if (done.length) await sleep(IN_APP_SETTLE_MS, deadline);
  return { trace: done.length ? done.join(" → ") : undefined, ok: !failure, failure };
}

/**
 * What a challenge actually looks at: the browser's own account of itself. Read in one
 * page so two installs (a dev machine and the container) can be compared line by line --
 * a missing GL stack or a browser with no fonts is invisible from the outside but reads
 * as automation from Cloudflare's side.
 */
const FINGERPRINT_PROBE = `(function () {
  var out = {};
  try {
    out.ua = navigator.userAgent;
    out.uaData = navigator.userAgentData
      ? navigator.userAgentData.brands.map(function (b) { return b.brand + " " + b.version; }).join(", ")
      : null;
    out.platform = navigator.platform;
    out.languages = (navigator.languages || []).join(",");
    out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    out.cores = navigator.hardwareConcurrency;
    out.memoryGb = navigator.deviceMemory || null;
    out.webdriver = navigator.webdriver;
    out.screen = screen.width + "x" + screen.height + "@" + window.devicePixelRatio;
    out.plugins = navigator.plugins.length;
  } catch (e) { out.navError = String(e); }

  // WebGL: a challenge reads the unmasked vendor/renderer. No GL stack at all is a
  // stronger signal than any UA string.
  try {
    var c = document.createElement("canvas");
    var gl = c.getContext("webgl") || c.getContext("experimental-webgl");
    if (!gl) {
      out.webgl = "unavailable";
    } else {
      var dbg = gl.getExtension("WEBGL_debug_renderer_info");
      out.webgl = dbg
        ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) + " / " + gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.VENDOR) + " / " + gl.getParameter(gl.RENDERER);
      out.webglVersion = gl.getParameter(gl.VERSION);
    }
    out.webgl2 = !!c.getContext("webgl2");
  } catch (e) { out.webgl = "error: " + e; }

  // Fonts, without fontconfig: a glyph the browser cannot draw measures the same as a
  // private-use character, so equal widths mean the font is missing (tofu).
  try {
    var cv = document.createElement("canvas").getContext("2d");
    var width = function (text, font) { cv.font = font; return cv.measureText(text).width; };
    var missing = width("\\uE000\\uE000", "16px sans-serif");
    out.latinOk = width("Bemby", "16px sans-serif") !== width("\\uE000\\uE000\\uE000\\uE000\\uE000", "16px sans-serif");
    out.cjkOk = width("\\u7B7E\\u5230", "16px sans-serif") !== missing;
    out.emojiOk = width("\\uD83C\\uDFAF", "16px sans-serif") !== width("\\uE000", "16px sans-serif");
    out.fontFamilies = ["sans-serif", "DejaVu Sans", "FreeSans", "Noto Sans CJK SC", "Noto Color Emoji"]
      .filter(function (f) { return document.fonts.check('16px "' + f + '"'); })
      .join(", ") || "none";
  } catch (e) { out.fontError = String(e); }

  return out;
})()`;

export type BrowserEnvReport = Record<string, unknown>;

/**
 * Reads the probe. `warnings` are things that stop the browser being useful or are a
 * direct automation tell; `notes` are differences worth seeing when comparing two
 * installs but which are not known to fail on their own -- a working setup passes
 * challenges with no GL stack at all, so that belongs in notes, not warnings.
 */
export function envReview(env: BrowserEnvReport): { warnings: string[]; notes: string[] } {
  const warnings: string[] = [];
  const notes: string[] = [];

  if (env.probeError) warnings.push(`The page could not be read: ${env.probeError}`);
  if (env.webdriver === true) {
    warnings.push("navigator.webdriver is true, which is a direct automation tell.");
  }
  if (env.latinOk === false) {
    warnings.push(
      "No usable fonts at all: fontconfig is finding none of the installed ones, so every " +
        "glyph is a box and text measures unlike any real browser.",
    );
  }
  if (typeof env.cores === "number" && env.cores <= 1) {
    warnings.push(`hardwareConcurrency is ${env.cores}: a real desktop reports more.`);
  }

  const webgl = String(env.webgl ?? "");
  if (!webgl || webgl === "unavailable" || webgl.startsWith("error")) {
    notes.push(
      "No WebGL. Worth comparing between installs, but not a blocker on its own: " +
        "challenges are passed on setups that report none.",
    );
  }
  if (env.webgl2 === false) notes.push("No WebGL2.");
  if (env.latinOk !== false && env.cjkOk === false) {
    notes.push("CJK glyphs are missing, so Chinese text renders as boxes (matching still works).");
  }
  if (env.emojiOk === false) notes.push("Emoji glyphs are missing.");
  if (env.uaData === null) {
    notes.push("No User-Agent Client Hints: expected off a secure origin, a real gap on one.");
  }
  return { warnings, notes };
}

/**
 * Launches the installed browser and checks that it actually renders: the same thing a
 * Mini App step depends on, told apart from a Cloudflare or network problem. Handy on a
 * server where the browser is an on-demand install and nothing else can be seen.
 * `env` reports what the page sees of itself, for comparing one install against another.
 */
export async function testBrowser(proxyUrl?: string): Promise<{
  ok: boolean;
  executable?: string;
  version?: string;
  renderedText?: string;
  screenshot?: string;
  error?: string;
  env?: BrowserEnvReport;
  /** Things that stop the browser being useful, or read as automation outright. */
  warnings?: string[];
  /** Differences worth comparing between installs, none fatal on its own. */
  notes?: string[];
  /** Country the exit came out in, which also proves TLS and the proxy work. */
  exitCountry?: string;
}> {
  const executable = chromiumExecutable();
  if (!executable) return { ok: false, error: "Chromium is not installed" };

  let browser: Browser | undefined;
  let cleanup: (() => void) | undefined;
  try {
    const launched = await launchBrowser(proxyUrl);
    browser = launched.browser;
    cleanup = launched.cleanup;
    const page = launched.page;
    const version = await browser.version().catch(() => undefined);
    await page.setContent("<h1 id=probe>bemby browser ok</h1>").catch(() => {});
    const renderedText = await page
      .evaluate(() => document.body?.innerText ?? "")
      .catch((err: any) => `evaluate failed: ${err?.message ?? err}`);
    // Read the fingerprint off a real https page: client hints and anything else gated on
    // a secure context do not exist on about:blank, and reporting them as absent there
    // would send someone chasing a difference that is only in the probe.
    let exitCountry: string | undefined;
    const secure = await page
      .goto(TRACE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (secure) {
      const trace = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      exitCountry = /(?:^|\n)loc=([A-Z]{2})/.exec(trace)?.[1];
    }
    const env = (await page.evaluate(FINGERPRINT_PROBE).catch((err: any) => ({
      probeError: err?.message ?? String(err),
    }))) as BrowserEnvReport;
    if (!secure) env.secureOrigin = false;
    const review = envReview(env);
    return {
      ok: typeof renderedText === "string" && renderedText.includes("bemby browser ok"),
      executable,
      version,
      env,
      exitCountry,
      warnings: review.warnings,
      notes: review.notes,
      renderedText,
      screenshot: await screenshotOf(page),
    };
  } catch (err: any) {
    return { ok: false, executable, error: err?.message ?? String(err) };
  } finally {
    await browser?.close().catch(() => {});
    cleanup?.();
  }
}

/** JPEG of what the browser is looking at, small enough to keep in a job log. */
async function screenshotOf(page: Page): Promise<string | undefined> {
  const shot = await page
    .screenshot({ type: "jpeg", quality: 45, encoding: "base64" })
    .catch(() => undefined);
  if (typeof shot !== "string" || !shot) return undefined;
  // Job logs are stored as JSON in SQLite; an oversized image is not worth keeping
  if (shot.length > 700_000) return undefined;
  return `data:image/jpeg;base64,${shot}`;
}

/** One load-and-solve pass through a single exit (the proxy, or direct). */
async function attemptLoad(
  url: string,
  proxyUrl: string | undefined,
  opts: LoadOptions,
  budgetDeadline: number,
): Promise<CheckinPageResult> {
  const finalHost = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  })();
  let browser: Browser | undefined;
  let cleanup: (() => void) | undefined;
  // Renderer trouble the page reports on its own: a crashed tab or a main request
  // that never arrived both leave a blank page that otherwise looks challenge-free.
  const troubles: string[] = [];
  // Trouble from the exit probe belongs to the probe, not to the page being judged
  let probing = false;
  const note = (msg: string) => {
    if (probing) return;
    // A challenge page aborts its own load on the way to the destination, so an
    // aborted request says nothing about whether the page came up
    if (/ERR_ABORTED/i.test(msg)) return;
    if (troubles.length < 5 && !troubles.includes(msg)) troubles.push(msg);
  };
  try {
    const launched = await launchBrowser(proxyUrl);
    browser = launched.browser;
    cleanup = launched.cleanup;
    const page = launched.page;

    page.on("error", (err) => note(`page crashed: ${err?.message ?? err}`));
    page.on("pageerror", (err: Error) => note(`page script error: ${err?.message ?? err}`));
    page.on("requestfailed", (req: any) => {
      if (req?.isNavigationRequest?.()) note(`request failed: ${req.failure()?.errorText}`);
    });

    // In dev the backend runs via tsx/esbuild, which wraps functions passed to
    // page.evaluate() with a __name() helper that doesn't exist in the browser.
    // Shim it (string form, so this injection itself isn't instrumented) so the
    // evaluate() calls below work under tsx too; tsc production builds don't need it.
    await page
      .evaluateOnNewDocument("window.__name = window.__name || function (a) { return a; };")
      .catch(() => {});

    if (opts.miniApp) {
      await page.evaluateOnNewDocument(WEBVIEW_PROXY_SHIM).catch(() => {});
    }

    // Clock and language to match the exit IP, before anything on the target is loaded
    probing = true;
    await alignWithExit(page, launched.key, launched.geo, budgetDeadline);
    probing = false;

    await page
      .goto(url, {
        waitUntil: "domcontentloaded",
        timeout: Math.max(5_000, capped(NAV_TIMEOUT_MS, budgetDeadline)),
      })
      .catch((err: any) => {
        // The challenge page may abort/redirect mid-load; the poll below is the
        // real signal, so a goto rejection isn't fatal -- but it is recorded, since
        // a page that never loaded looks exactly like one with no challenge on it.
        note(`navigation: ${err?.message ?? err}`);
      });

    // Compare without the fragment: a Mini App rewriting its hash route is not the
    // portal navigating away, and counting it would call the challenge solved at once.
    const withoutHash = (u: string) => u.split("#")[0];
    const startUrl = withoutHash(page.url());
    if (opts.miniApp) await waitForAppReady(page, budgetDeadline);

    // Works a challenge that is on the page right now. Returns null when there is
    // none, so callers can tell "nothing to do" from "tried and failed".
    const solveChallenge = async (): Promise<boolean | null> => {
      const interstitial = await isInterstitial(page);
      let widget = await hasTurnstileWidget(page);

      // Not every app uses Turnstile: a Cap checkbox is solved in the browser instead.
      if (!interstitial && !widget && (await hasCapWidget(page))) {
        return solveCap(page, Math.min(Date.now() + CHALLENGE_TIMEOUT_MS, budgetDeadline));
      }

      // A verify portal may load the Turnstile script and only render the widget once
      // its single button is pressed, so try that before concluding there is nothing.
      if (!interstitial && !widget && (await hasTurnstileScript(page))) {
        if (await clickVerifyButton(page)) {
          for (let i = 0; i < 6 && !widget; i++) {
            await sleep(READY_POLL_MS, budgetDeadline);
            widget = await hasTurnstileWidget(page);
          }
        }
      }
      if (!interstitial && !widget) return null;

      // Custom verify portals only engage Turnstile after a real click.
      if (widget) await clickVerifyButton(page);

      const challengeStart = Date.now();
      const deadline = Math.min(challengeStart + CHALLENGE_TIMEOUT_MS, budgetDeadline);
      let widgetClicks = 0;
      while (Date.now() < deadline) {
        await sleep(POLL_MS, deadline);
        // Strongest signal: a Turnstile token was issued.
        if (await turnstileToken(page)) return true;
        // Nudge a widget that is sitting there unsolved: it may be an interactive
        // checkbox that nothing has clicked yet. Spaced out, so a widget that is
        // verifying on its own is not interrupted.
        if (widget && widgetClicks < 3 && Date.now() > challengeStart + (widgetClicks + 1) * 4_000) {
          widgetClicks++;
          await clickTurnstileWidget(page);
        }
        // A challenge that cleared and left no widget behind is done.
        if (!(await isInterstitial(page)) && !(await hasTurnstileWidget(page))) return true;
        // Portal navigated away or shows a success message.
        if (withoutHash(page.url()) !== startUrl) return true;
        const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
        if (SUCCESS_RE.test(body)) return true;
        // The site has already rejected this exit; waiting the rest out gains nothing
        if (REFUSED_RE.test(body)) return false;
      }
      return false;
    };

    // The challenge may be up already, or an app may only raise it once a provider or
    // action is chosen inside it -- so try before the in-app steps and again after.
    const before = await solveChallenge();
    let solved = before ?? true;
    let challenged = before !== null;

    // Some apps render their own "verification failed" instead of a challenge widget
    if (solved) {
      const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (REFUSED_RE.test(body)) {
        solved = false;
        challenged = true;
      }
    }

    await sleep(SETTLE_MS, budgetDeadline);

    // A Mini App checkin is a tap inside the app, not the page load itself.
    let inAppAction: string | undefined;
    let inAppFailure: string | undefined;
    if (opts.miniApp && solved) {
      const clicks = await runInAppClicks(
        page,
        opts.inAppClicks ?? [],
        budgetDeadline,
        opts.solveQuestion,
      );
      inAppAction = clicks.trace;
      inAppFailure = clicks.failure;

      // A verification the app raises only once the checkin is pressed needs a moment to
      // render. Asking once, immediately, sees nothing there and calls the step done --
      // so while the app says it wants one, keep looking for it.
      const challengeBy = Math.min(Date.now() + POST_CLICK_CHALLENGE_MS, budgetDeadline);
      let after: boolean | null = null;
      for (;;) {
        after = await solveChallenge();
        if (after !== null) break;
        const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
        if (!VERIFY_REQUIRED_RE.test(body) || Date.now() >= challengeBy) break;
        await sleep(POLL_MS, challengeBy);
      }
      if (after !== null) {
        challenged = true;
        solved = after;
      }
    }

    // A widget-based challenge is verified server-side after the token is issued, so
    // the app's own wording is the outcome. Give it a bounded wait rather than closing
    // the browser while the request is still in flight.
    let text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (solved && challenged && !SUCCESS_RE.test(text)) {
      const deadline = Math.min(Date.now() + CONFIRM_TIMEOUT_MS, budgetDeadline);
      while (Date.now() < deadline) {
        await sleep(POLL_MS, deadline);
        text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
        if (SUCCESS_RE.test(text)) break;
      }
    }

    const pageTitle = (await page.title().catch(() => "")) || undefined;
    const navError = troubles.length ? troubles.join("; ") : undefined;

    const verdict = opts.miniApp
      ? miniAppVerdict({ challenged, solved, text, inAppAction, inAppFailure, navError })
      : { ok: solved, reason: undefined as string | undefined };

    return {
      ok: verdict.ok,
      challenged,
      text,
      finalHost,
      inAppAction,
      reason: verdict.reason,
      navError,
      pageTitle,
      // A challenge this exit was refused, or a page it never loaded, is worth retrying
      // elsewhere; a control that is not on the page is not.
      exitRelated: !!navError || (challenged && !verdict.ok) || !text.trim(),
      screenshot: opts.screenshot ? await screenshotOf(page) : undefined,
    };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (/not installed|executablePath|ENOENT|Could not find|Failed to launch/i.test(msg)) {
      console.error(`[cloudflare] Chromium not available: ${msg}`);
    } else {
      console.error(`[cloudflare] Failed to load ${finalHost}: ${msg}`);
    }
    return {
      ok: false,
      challenged: false,
      text: "",
      finalHost,
      reason: msg,
      navError: msg,
      exitRelated: true,
    };
  } finally {
    await browser?.close().catch(() => {});
    cleanup?.();
  }
}

/**
 * Load `url` in the installed Chromium, pass any Cloudflare challenge (full-page
 * interstitial or embedded Turnstile widget), and return the final page's visible
 * text so the caller can match success/fail keywords.
 *
 * Cloudflare judges the exit IP as much as the browser, so when the caller offers a pool
 * of proxies (`opts.proxyCandidates`) each is tried until one is accepted. Only a refused
 * challenge moves on to the next -- a page that loads with no challenge, or one that
 * clears it, is done. `opts.refreshUrl` re-mints the address between attempts, which a
 * signed Mini App URL needs since its init data ages.
 *
 * `opts.maxWaitMs` bounds the whole thing: exits are tried only while budget remains,
 * so a hunt through a large pool cannot run for an unbounded stretch.
 */
export async function loadCheckinUrl(
  url: string,
  proxyUrl?: string,
  opts: LoadOptions = {},
): Promise<CheckinPageResult> {
  const candidates: ProxyCandidate[] = opts.proxyCandidates?.length
    ? opts.proxyCandidates
    : [{ id: proxyUrl ? "job" : "direct", label: proxyUrl ? "job proxy" : "direct", url: proxyUrl }];

  const budget = opts.maxWaitMs && opts.maxWaitMs > 0 ? opts.maxWaitMs : DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budget;

  let target = url;
  let last: CheckinPageResult | undefined;
  const trace: string[] = [];
  const refusedProxyIds: string[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (i > 0) {
      if (msLeft(deadline) < MIN_ATTEMPT_MS) {
        trace.push(`out of time after ${i} exit(s) (budget ${Math.round(budget / 1000)}s)`);
        console.log(`[cloudflare] budget spent after ${i} exit(s), giving up`);
        break;
      }
      console.log(
        `[cloudflare] challenge refused, retrying via ${candidate.label} (${i + 1}/${candidates.length})`,
      );
      // A signed Mini App URL ages, so mint a fresh one for this attempt when possible
      if (opts.refreshUrl) {
        const fresh = await opts.refreshUrl().catch(() => undefined);
        if (fresh) target = fresh;
      }
    }

    const result = await attemptLoad(target, candidate.url, opts, deadline);
    if (!result.ok) refusedProxyIds.push(candidate.id);
    trace.push(
      [
        `${candidate.label}: ${result.ok ? "ok" : "failed"}`,
        result.challenged ? "challenged" : undefined,
        result.pageTitle ? `title="${result.pageTitle}"` : undefined,
        `text ${result.text.trim().length} chars`,
        result.inAppAction ? `in-app: ${result.inAppAction}` : undefined,
        result.reason,
      ]
        .filter(Boolean)
        .join(" | "),
    );
    last = {
      ...result,
      proxyId: candidate.id,
      proxyLabel: candidate.label,
      attempts: i + 1,
      trace: [...trace],
      refusedProxyIds: [...refusedProxyIds],
    };
    if (result.ok) return last;

    // Nothing another exit can do about a failure inside the app itself
    if (result.exitRelated === false) {
      trace.push("failed inside the app, so no other exit was tried");
      console.log("[cloudflare] failure is not about the exit; leaving the rest of the pool alone");
      break;
    }
  }

  return { ...last!, trace: [...trace], refusedProxyIds: [...refusedProxyIds] };
}
