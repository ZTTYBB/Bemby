import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
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

// The image ships without a browser to stay small. When the user enables
// Cloudflare solving, Chromium is installed on demand into the data dir (a
// persistent volume) so it survives restarts. On Alpine the browser must be the
// musl-native apk build, installed into an alternate root via a doas-gated script.

function dataDir(): string {
  return path.dirname(process.env.DB_PATH ?? path.resolve(process.cwd(), "data/bemby.db"));
}

/** Data-dir subfolder holding the on-demand Chromium install (alternate apk root). */
export function cfChromiumRoot(): string {
  return path.join(dataDir(), "cf-chromium");
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

/** Resolves the Chromium executable: explicit env, then the data-dir install, then a system browser. */
export function chromiumExecutable(): string | undefined {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath && existsSync(envPath)) return envPath;
  const root = cfChromiumRoot();
  const candidates = [
    path.join(root, "usr/lib/chromium/chrome"),
    path.join(root, "usr/lib/chromium/chromium"),
    path.join(root, "usr/bin/chromium-browser"),
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
  return candidates.find((p) => existsSync(p));
}

export function isChromiumInstalled(): boolean {
  return !!chromiumExecutable();
}

/**
 * Installs Chromium into the data dir via the baked, doas-gated script
 * (`doas install-cf-chromium <root>`). Long-running (downloads ~150MB). Resolves
 * with the tail of the output; rejects on non-zero exit.
 */
export function installCfChromium(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    // The doas + apk installer only exists in the Docker (Alpine) image.
    if (!existsSync("/sbin/apk") && !existsSync("/usr/bin/apk")) {
      resolve({
        ok: false,
        output:
          "On-demand install is only available in the Docker image. For local development, " +
          "set PUPPETEER_EXECUTABLE_PATH to a Chromium binary in backend/.env and restart.",
      });
      return;
    }
    const root = cfChromiumRoot();
    const proc = spawn("doas", ["/usr/local/bin/install-cf-chromium", root], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const cap = (b: Buffer) => {
      out += b.toString();
      if (out.length > 8000) out = out.slice(-8000);
    };
    proc.stdout.on("data", cap);
    proc.stderr.on("data", cap);
    proc.on("error", (err) => resolve({ ok: false, output: `${err.message}\n${out}` }));
    proc.on("close", (code) => resolve({ ok: code === 0 && isChromiumInstalled(), output: out }));
  });
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
        // Language has to be set at launch to stay consistent: this covers both
        // navigator.language(s) and the Accept-Language header
        ...(geo?.lang ? [`--lang=${geo.lang}`, `--accept-lang=${geo.lang}`] : []),
      ],
      customConfig: {
        chromePath: executablePath,
        ...(profile.dir ? { userDataDir: profile.dir } : {}),
      },
      proxy,
    });
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
  await page.click(sel).catch(() => {});
  return true;
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

/**
 * Finds a control inside the Mini App by its visible text. Mini apps are ordinary web
 * apps, so the control may be a real button, a link, or any element with a click
 * handler; the label is located first, then the nearest thing that behaves like a
 * control. Tags it with `data-cf-checkin` for a CDP click. Reports `done: true` when
 * that control is disabled or reads as already used, so it is left alone.
 */
async function findInAppCheckin(
  page: Page,
  labelRe: RegExp,
): Promise<{ label: string; done: boolean } | null> {
  return page
    .evaluate(
      (labelSrc: string, doneSrc: string) => {
        const label = new RegExp(labelSrc, "i");
        const done = new RegExp(doneSrc, "i");
        // Direct text nodes only: identifies the element holding the label itself
        // rather than every wrapper around it.
        const ownText = (el: Element) =>
          Array.from(el.childNodes)
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent ?? "")
            .join("")
            .trim();

        const visible = (el: HTMLElement) =>
          el.offsetParent !== null || el.getClientRects().length > 0;

        // The label may sit inside a real control, or on an element that merely has a
        // click handler (mini apps bind these to divs freely). Walk out a few levels
        // looking for either, then fall back to the label element itself.
        const controlFor = (el: HTMLElement): HTMLElement => {
          const semantic = el.closest(
            "button,[role=button],a[href],input[type=submit],input[type=button]",
          ) as HTMLElement | null;
          if (semantic) return semantic;
          let node: HTMLElement | null = el;
          for (let i = 0; node && i < 3; i++, node = node.parentElement) {
            if (getComputedStyle(node).cursor === "pointer") return node;
          }
          return el;
        };

        for (const el of Array.from(document.querySelectorAll("*")) as HTMLElement[]) {
          const text = (ownText(el) || (el as HTMLInputElement).value || "").trim();
          if (!text || text.length > 30 || !label.test(text)) continue;
          if (!visible(el)) continue;

          const target = controlFor(el);
          if (!visible(target)) continue;

          // A disabled control is the app's way of saying the action is spent
          const full = (target.textContent ?? "").trim();
          const off =
            (target as HTMLButtonElement).disabled ||
            target.getAttribute("aria-disabled") === "true" ||
            target.closest("[disabled],[aria-disabled='true']") !== null;
          if (off || done.test(full)) return { label: (full || text).slice(0, 40), done: true };
          target.setAttribute("data-cf-checkin", "1");
          return { label: text, done: false };
        }
        return null;
      },
      labelRe.source,
      IN_APP_DONE_RE.source,
    )
    .catch(() => null);
}

// Presses one control inside the Mini App: the one named by `wanted`, or a
// checkin-worded one when no label is given. Returns what happened, or undefined when
// the label is nowhere on the page.
async function clickInAppControl(page: Page, wanted?: string): Promise<string | undefined> {
  const labelRe = wanted ? new RegExp(escapeRe(wanted), "i") : IN_APP_LABEL_RE;

  const target = await findInAppCheckin(page, labelRe);
  if (target?.done) return `already done: ${target.label}`;
  if (target) {
    // Real (CDP) click: mini apps commonly bind pointer events, not synthetic clicks
    await page.click("[data-cf-checkin='1']").catch(() => {});
    await page.evaluate(() =>
      document.querySelector("[data-cf-checkin]")?.removeAttribute("data-cf-checkin"),
    ).catch(() => {});
    return target.label;
  }

  // No control to press: apps that render the spent state as plain text (a label
  // beside a disabled control) still say so in the page text.
  const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  if (labelRe.test(text) && IN_APP_DONE_RE.test(text)) return "already done";
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
  await page.click("[data-cf-input='1']").catch(() => {});
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

    const outcome = await clickInAppControl(page, step);
    if (!outcome) {
      // A label that never appears is worth reporting: the app may have changed
      if (step) done.push(`"${step}" not found`);
      failure = step
        ? `"${step}" is not on the app page`
        : "no checkin control was found in the app";
      break;
    }
    done.push(outcome);
    await sleep(IN_APP_STEP_MS, deadline);
    if (outcome.startsWith("already done")) break;
  }

  // Let the last step's request round-trip before the page text is scraped
  if (done.length) await sleep(IN_APP_SETTLE_MS, deadline);
  return { trace: done.length ? done.join(" → ") : undefined, ok: !failure, failure };
}

/**
 * Launches the installed browser and checks that it actually renders: the same thing a
 * Mini App step depends on, told apart from a Cloudflare or network problem. Handy on a
 * server where the browser is an on-demand install and nothing else can be seen.
 */
export async function testBrowser(proxyUrl?: string): Promise<{
  ok: boolean;
  executable?: string;
  version?: string;
  renderedText?: string;
  screenshot?: string;
  error?: string;
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
    return {
      ok: typeof renderedText === "string" && renderedText.includes("bemby browser ok"),
      executable,
      version,
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

      const after = await solveChallenge();
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
      screenshot: opts.screenshot ? await screenshotOf(page) : undefined,
    };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (/not installed|executablePath|ENOENT|Could not find|Failed to launch/i.test(msg)) {
      console.error(`[cloudflare] Chromium not available: ${msg}`);
    } else {
      console.error(`[cloudflare] Failed to load ${finalHost}: ${msg}`);
    }
    return { ok: false, challenged: false, text: "", finalHost, reason: msg, navError: msg };
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
  }

  return { ...last!, trace: [...trace], refusedProxyIds: [...refusedProxyIds] };
}
