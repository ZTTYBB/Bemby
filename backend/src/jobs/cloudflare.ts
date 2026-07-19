import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { connect } from "puppeteer-real-browser";
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

/** Data-dir subfolder holding the on-demand Chromium install (alternate apk root). */
export function cfChromiumRoot(): string {
  const dataDir = path.dirname(process.env.DB_PATH ?? path.resolve(process.cwd(), "data/bemby.db"));
  return path.join(dataDir, "cf-chromium");
}

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
};

const NAV_TIMEOUT_MS = 45_000;
const CHALLENGE_TIMEOUT_MS = 45_000;
const POLL_MS = 1_000;
// Let a post-challenge redirect/render settle before scraping text.
const SETTLE_MS = 1_500;

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

// Launches a real (rebrowser-patched) Chromium via puppeteer-real-browser: headed
// under an auto-managed Xvfb display with a real cursor, and turnstile:true so it
// auto-clicks Cloudflare Turnstile. This is the realistic path to pass Turnstile.
async function launchBrowser(proxyUrl?: string): Promise<{ browser: Browser; page: Page }> {
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

  return connect({
    headless: false,
    turnstile: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1280,800"],
    customConfig: { chromePath: executablePath },
    proxy: proxyOption(proxyUrl),
  });
}

// Full-page Cloudflare interstitial ("Just a moment...").
async function isInterstitial(page: Page): Promise<boolean> {
  const title = (await page.title().catch(() => "")) || "";
  if (/just a moment|checking your browser|attention required|请稍候|正在验证/i.test(title)) return true;
  return page
    .evaluate(() => !!document.querySelector("#challenge-form, #challenge-running"))
    .catch(() => false);
}

// A Turnstile challenge is present or in play: a widget, its iframe, or the
// Turnstile script that renders it after an interaction (custom verify portals).
async function hasTurnstile(page: Page): Promise<boolean> {
  return page
    .evaluate(
      () =>
        !!document.querySelector(
          ".cf-turnstile, iframe[src*='challenges.cloudflare.com'], script[src*='challenges.cloudflare.com/turnstile']",
        ),
    )
    .catch(() => false);
}

// A solved Turnstile populates this hidden field with a token.
async function turnstileToken(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const el = document.querySelector(
        "[name='cf-turnstile-response']",
      ) as HTMLInputElement | HTMLTextAreaElement | null;
      return el?.value ?? "";
    })
    .catch(() => "");
}

// Text a verify portal shows once the identity check has gone through.
const SUCCESS_RE = /success|verified|verification complete|completed|已(驗|验)證|(驗|验)證成功|(驗|验)證完成/i;

// Some verify portals only engage Turnstile after the user clicks a button. A
// real (CDP) click is required -- Turnstile ignores untrusted element.click()
// events. Generic: prefer a button whose label reads like a verify/continue
// action, otherwise fall back to the sole visible button (these portals almost
// always have exactly one), so it isn't tied to any one site's wording.
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
      const target =
        byText ??
        (visible.length === 1 ? visible[0] : visible.find((e) => e.tagName === "BUTTON")) ??
        null;
      if (!target) return null;
      target.setAttribute("data-cf-click", "1");
      return "[data-cf-click='1']";
    })
    .catch(() => null);
  if (!sel) return false;
  await page.click(sel).catch(() => {});
  return true;
}

/**
 * Load `url` in headless Chromium, pass any Cloudflare challenge (full-page
 * interstitial or embedded Turnstile widget), and return the final page's visible
 * text so the caller can match success/fail keywords.
 */
export async function loadCheckinUrl(url: string, proxyUrl?: string): Promise<CheckinPageResult> {
  const finalHost = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  })();
  let browser: Browser | undefined;
  try {
    const launched = await launchBrowser(proxyUrl);
    browser = launched.browser;
    const page = launched.page;

    // In dev the backend runs via tsx/esbuild, which wraps functions passed to
    // page.evaluate() with a __name() helper that doesn't exist in the browser.
    // Shim it (string form, so this injection itself isn't instrumented) so the
    // evaluate() calls below work under tsx too; tsc production builds don't need it.
    await page
      .evaluateOnNewDocument("window.__name = window.__name || function (a) { return a; };")
      .catch(() => {});

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {
      // The challenge page may abort/redirect mid-load; the poll below is the
      // real signal, so a goto rejection isn't fatal.
    });

    const startUrl = page.url();
    const interstitial = await isInterstitial(page);
    const turnstile = await hasTurnstile(page);
    const challenged = interstitial || turnstile;

    // A plain page with no challenge indicators is considered loaded/ok.
    let solved = !challenged;

    if (challenged) {
      // Custom verify portals only engage Turnstile after a real click.
      if (turnstile) await clickVerifyButton(page);

      const deadline = Date.now() + CHALLENGE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        // Strongest signal: a Turnstile token was issued.
        if (await turnstileToken(page)) { solved = true; break; }
        // A full-page interstitial that clears (and left no widget) is done.
        if (interstitial && !(await isInterstitial(page)) && !(await hasTurnstile(page))) { solved = true; break; }
        // Portal navigated away or shows a success message.
        if (page.url() !== startUrl) { solved = true; break; }
        const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
        if (SUCCESS_RE.test(body)) { solved = true; break; }
      }
    }

    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    return { ok: solved, challenged, text, finalHost };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (/not installed|executablePath|ENOENT|Could not find|Failed to launch/i.test(msg)) {
      console.error(`[cloudflare] Chromium not available: ${msg}`);
    } else {
      console.error(`[cloudflare] Failed to load ${finalHost}: ${msg}`);
    }
    return { ok: false, challenged: false, text: "", finalHost };
  } finally {
    await browser?.close().catch(() => {});
  }
}
