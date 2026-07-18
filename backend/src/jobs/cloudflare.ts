import type { Browser, Page } from "puppeteer-core";

// Completes a checkin that hands back a URL behind Cloudflare's "I am not a bot"
// (managed challenge / Turnstile). A real headless Chromium loads the URL and
// waits for the challenge to clear; because Bemby runs on the user's own host,
// the browser exits from the same IP (and proxy, if set) as expected, so simply
// loading the page registers the checkin server-side.

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

// Chromium schemes we can hand to --proxy-server. MTProto/other schemes are skipped.
const PROXY_SCHEMES = new Set(["http:", "https:", "socks4:", "socks5:"]);

// Splits a proxy URL into the pieces Chromium needs: --proxy-server takes only
// scheme://host:port, and http(s) auth is applied separately via authenticate().
function parseProxy(proxyUrl?: string): {
  server?: string;
  username?: string;
  password?: string;
  isSocks: boolean;
} {
  if (!proxyUrl) return { isSocks: false };
  try {
    const u = new URL(proxyUrl);
    if (!PROXY_SCHEMES.has(u.protocol)) return { isSocks: false };
    return {
      server: `${u.protocol}//${u.host}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      isSocks: u.protocol.startsWith("socks"),
    };
  } catch {
    return { isSocks: false };
  }
}

async function launch(proxyServer?: string): Promise<Browser> {
  const puppeteer = await import("puppeteer-core");
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser";
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    // Drop the navigator.webdriver flag Cloudflare fingerprints on.
    "--disable-blink-features=AutomationControlled",
    "--window-size=1280,800",
    "--lang=en-US,en",
  ];
  if (proxyServer) args.push(`--proxy-server=${proxyServer}`);
  return puppeteer.launch({ executablePath, headless: true, args });
}

// Light evasions so the managed challenge treats us as a normal browser.
async function harden(page: Page, browser: Browser): Promise<void> {
  const ua = (await browser.userAgent()).replace(/Headless/gi, "");
  await page.setUserAgent(ua);
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  });
}

// Are we still sitting on a Cloudflare interstitial?
async function isChallenge(page: Page): Promise<boolean> {
  const title = (await page.title().catch(() => "")) || "";
  if (/just a moment|checking your browser|attention required|请稍候|正在验证/i.test(title)) return true;
  return page
    .evaluate(
      () =>
        !!document.querySelector(
          "#challenge-form, #challenge-running, .cf-turnstile, iframe[src*='challenges.cloudflare.com']",
        ),
    )
    .catch(() => false);
}

/**
 * Load `url` in headless Chromium, wait out any Cloudflare challenge, and return
 * the final page's visible text so the caller can match success/fail keywords.
 */
export async function loadCheckinUrl(url: string, proxyUrl?: string): Promise<CheckinPageResult> {
  const finalHost = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  })();
  const { server, username, password, isSocks } = parseProxy(proxyUrl);
  if (isSocks && (username || password)) {
    console.warn("[cloudflare] SOCKS proxy auth is not supported by Chromium; attempting without credentials");
  }

  let browser: Browser | undefined;
  try {
    browser = await launch(server);
    const page = await browser.newPage();
    await harden(page, browser);
    if (server && !isSocks && username) {
      await page.authenticate({ username, password: password ?? "" });
    }

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {
      // The challenge page may abort/redirect mid-load; the challenge poll below
      // is the real signal, so a goto rejection isn't fatal.
    });

    let challenged = await isChallenge(page);
    if (challenged) {
      const deadline = Date.now() + CHALLENGE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (!(await isChallenge(page))) break;
      }
    }

    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const stillChallenged = await isChallenge(page);
    const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    return { ok: !stillChallenged, challenged, text, finalHost };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (/executablePath|ENOENT|Could not find|Failed to launch/i.test(msg)) {
      console.error(`[cloudflare] Chromium not available (${msg}). Ensure the container ships chromium.`);
    } else {
      console.error(`[cloudflare] Failed to load ${finalHost}: ${msg}`);
    }
    return { ok: false, challenged: false, text: "", finalHost };
  } finally {
    await browser?.close().catch(() => {});
  }
}
