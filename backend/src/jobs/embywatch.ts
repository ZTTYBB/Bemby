import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';
import { lookup } from 'node:dns';
import { db } from '../db/database';
import type { EmbywatchConfig, EmbywatchLog } from '../types';
import { expandCommand } from './checkin';

// Per-username cache of the expanded device name. Persisting it keeps random
// tokens (e.g. {word:4}) stable across runs; we only re-expand when the template
// changes (captured by `sig`). Keyed by Emby username since {username} varies.
const DEVICE_NAMES_KEY = 'emby_device_names';

type CachedDeviceName = { sig: string; deviceName: string };

function readDeviceNames(): Record<string, CachedDeviceName> {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(DEVICE_NAMES_KEY) as
      | { value: string }
      | undefined;
    if (!row?.value) return {};
    return JSON.parse(row.value) as Record<string, CachedDeviceName>;
  } catch {
    return {};
  }
}

function saveDeviceName(username: string, entry: CachedDeviceName): void {
  const map = readDeviceNames();
  map[username] = entry;
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    DEVICE_NAMES_KEY,
    JSON.stringify(map),
  );
}

// Expand template variables in the device name. {username} is the Emby account
// username for the job; random tokens ({word:N}, {num:N}, {alpha:N}, {uuid})
// come from expandCommand. The expanded value is persisted per username so random
// tokens stay stable across runs, and is only re-rolled when the template changes.
function resolveDeviceName(template: string, username: string): string {
  if (!template.includes('{')) return template;
  const sig = template;
  const cached = readDeviceNames()[username];
  if (cached && cached.sig === sig) return cached.deviceName;
  const deviceName = expandCommand(template, { username });
  saveDeviceName(username, { sig, deviceName });
  return deviceName;
}

// Forces IPv4-only DNS resolution so Happy Eyeballs doesn't waste the connect
// timeout on broken IPv6 routes in container environments.
const ipv4Agent = new Agent({
  connect: { lookup: (hostname, opts, cb) => lookup(hostname, { ...opts, family: 4 }, cb) },
});

const DEFAULT_UA = 'SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0';
const PROGRESS_INTERVAL_S = 30;
// Emby uses 100-nanosecond ticks (same as .NET TimeSpan)
const TICKS_PER_SECOND = 10_000_000;

function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

// Emby's dashboard shows the session's app name/version from the Client and
// Version fields of X-Emby-Authorization, not the HTTP User-Agent. Derive them
// from the chosen UA so a custom preset (e.g. "CapyPlayer/1.0") is reflected in
// the Emby backend instead of a hardcoded client name.
function parseUaClient(ua: string): { client: string; version: string } {
  const match = /^([^/\s]+)\/([^\s(]+)/.exec(ua.trim());
  if (match?.[1] && match?.[2]) {
    return { client: match[1], version: match[2] };
  }
  return parseUaClient(DEFAULT_UA);
}

function buildAuthHeader(deviceName: string, ua: string, token?: string): string {
  // DeviceId must stay URL-safe: some stream proxies embed it in signed
  // redirect URLs and break on whitespace (the display name can keep spaces)
  const deviceId = `${deviceName.replace(/\s+/g, '-')}`;
  const { client, version } = parseUaClient(ua);
  const parts = [
    `MediaBrowser Client="${client}"`,
    `Device="${deviceName}"`,
    `DeviceId="${deviceId}"`,
    `Version="${version}"`,
  ];
  if (token) parts.push(`Token="${token}"`);
  return parts.join(', ');
}

async function embyRequest<T = any>(
  baseUrl: string,
  path: string,
  opts: { method?: string; token?: string; ua: string; deviceName: string; body?: unknown; proxyUrl?: string; signal?: AbortSignal }
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const method = opts.method ?? 'GET';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': opts.ua,
    'X-Emby-Authorization': buildAuthHeader(opts.deviceName, opts.ua, opts.token),
  };
  const body = opts.body != null ? JSON.stringify(opts.body) : undefined;

  let res: Response;
  try {
    res = await undiciFetch(url, {
      method,
      headers,
      body,
      signal: opts.signal,
      dispatcher: opts.proxyUrl ? new ProxyAgent(opts.proxyUrl) : ipv4Agent,
    } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
  } catch (err: any) {
    // Network-level failure (ECONNREFUSED, ENOTFOUND, timeout, etc.)
    const cause = err?.cause?.message ?? err?.cause?.code ?? '';
    throw new Error(`Cannot reach Emby server at ${url}${cause ? ` — ${cause}` : ''}`);
  }

  const text = await res.text();
  if (!res.ok) {
    // Try to extract a human-readable message from Emby's JSON error body
    let detail = text;
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      if (typeof json.Message === 'string' && json.Message) detail = json.Message;
      else if (typeof json.message === 'string' && json.message) detail = json.message;
    } catch { /* leave detail as raw text */ }
    throw new Error(`Emby ${method} ${path} → ${res.status} ${res.statusText}: ${detail}`);
  }
  return text ? JSON.parse(text) : (null as T);
}

/** Resolves a configured proxy id to its URL from settings, if any. */
function resolveProxyUrl(proxyId?: string): string | undefined {
  if (!proxyId) return undefined;
  try {
    const raw = getSetting('proxies');
    if (!raw) return undefined;
    const list = JSON.parse(raw) as Array<{ id: string; name: string; url: string }>;
    return list.find(p => p.id === proxyId)?.url;
  } catch {
    return undefined;
  }
}

// Cap the connection test so the UI isn't stuck waiting on a dead host
const TEST_TIMEOUT_MS = 12_000;

/**
 * Authenticates against the Emby server without playing anything, so the UI
 * can confirm the server is reachable and the credentials are valid before a
 * job is saved.
 */
export async function testEmbyConnection(
  serverUrl: string,
  opts: { username: string; password: string; userAgent?: string; proxyId?: string },
): Promise<{ ok: boolean; userName?: string; error?: string }> {
  const ua = opts.userAgent || getSetting('default_ua') || DEFAULT_UA;
  const deviceName = resolveDeviceName(getSetting('default_device_name') ?? 'Mac', opts.username);
  const proxyUrl = resolveProxyUrl(opts.proxyId);
  try {
    const auth = await embyRequest<any>(serverUrl, '/Users/AuthenticateByName', {
      method: 'POST',
      ua,
      deviceName,
      proxyUrl,
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      body: { Username: opts.username, Pw: opts.password },
    });
    return { ok: true, userName: auth?.User?.Name };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Connection failed' };
  }
}

// Number of random items to try before giving up when verifying playability.
const MAX_PICK_ATTEMPTS = 5;
// Byte range fetched to confirm the media file is actually readable.
const PROBE_RANGE_BYTES = 65_535;

/**
 * Fetch the first bytes of a stream URL, as a real player would.
 * A readable file yields 206 (partial) or 200 with body bytes.
 */
async function probeStream(url: string, opts: { ua: string; proxyUrl?: string }): Promise<boolean> {
  try {
    const res = (await undiciFetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': opts.ua,
        Range: `bytes=0-${PROBE_RANGE_BYTES}`,
      },
      dispatcher: opts.proxyUrl ? new ProxyAgent(opts.proxyUrl) : ipv4Agent,
    } as Parameters<typeof undiciFetch>[1])) as unknown as Response;

    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel?.();
      return false;
    }
    const buf = await res.arrayBuffer();
    return buf.byteLength > 0;
  } catch {
    // Network-level failure reaching the stream, treat as unavailable
    return false;
  }
}

/**
 * Ask PlaybackInfo for the stream URL a real client would play. Some servers
 * front Emby with a proxy that only routes this form (e.g. redirecting
 * /videos/{id}/original.{container} to a dedicated stream host) and return
 * errors for the generic /Videos/{id}/stream path.
 */
async function getClientStreamUrl(
  baseUrl: string,
  itemId: string,
  mediaSourceId: string,
  opts: { token: string; ua: string; userId: string; deviceName: string; proxyUrl?: string; directOnly?: boolean }
): Promise<string | undefined> {
  try {
    const info = await embyRequest<any>(baseUrl, `/Items/${itemId}/PlaybackInfo?UserId=${opts.userId}`, {
      method: 'POST',
      ua: opts.ua,
      token: opts.token,
      deviceName: opts.deviceName,
      proxyUrl: opts.proxyUrl,
      body: { DeviceProfile: { MaxStreamingBitrate: 140_000_000 } },
    });
    const sources: any[] = info?.MediaSources ?? [];
    const source = sources.find(s => s.Id === mediaSourceId) ?? sources[0];
    // directOnly avoids the TranscodingUrl fallback so Real Watch stays direct play
    const path: string | undefined = opts.directOnly
      ? source?.DirectStreamUrl
      : (source?.DirectStreamUrl ?? source?.TranscodingUrl ?? undefined);
    if (!path) return undefined;
    if (/^https?:\/\//i.test(path)) return path;
    return `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
  } catch {
    // PlaybackInfo unsupported or failed, caller falls back to the static URL
    return undefined;
  }
}

/**
 * Confirm the media file is actually streamable, mimicking what a real player
 * does: fetch the first bytes of the stream. If the disk/mount is down, Emby
 * can't read the file and returns a non-2xx (or an empty body), so we treat the
 * item as unavailable and avoid reporting a fake watch.
 */
async function isMediaAvailable(
  baseUrl: string,
  itemId: string,
  mediaSourceId: string,
  opts: { token: string; ua: string; userId: string; deviceName: string; proxyUrl?: string }
): Promise<boolean> {
  // Prefer the URL a real client would play; proxies that offload streaming
  // to another host often only route this form
  const clientUrl = await getClientStreamUrl(baseUrl, itemId, mediaSourceId, opts);
  if (clientUrl && (await probeStream(clientUrl, opts))) return true;

  // Fall back to the generic static stream URL
  const params = new URLSearchParams({
    static: 'true',
    mediaSourceId,
    api_key: opts.token,
  });
  const staticUrl = `${baseUrl.replace(/\/$/, '')}/Videos/${itemId}/stream?${params.toString()}`;
  return probeStream(staticUrl, opts);
}

function appendParam(url: string, key: string, value: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
}

// Static direct-play stream URL, tied to the play session so the byte transfer
// registers against the reported Now Playing session on the Emby dashboard.
function buildStaticStreamUrl(
  baseUrl: string,
  itemId: string,
  mediaSourceId: string,
  opts: { token: string; playSessionId: string; deviceId: string }
): string {
  const params = new URLSearchParams({
    static: 'true',
    mediaSourceId,
    api_key: opts.token,
    PlaySessionId: opts.playSessionId,
    DeviceId: opts.deviceId,
  });
  return `${baseUrl.replace(/\/$/, '')}/Videos/${itemId}/stream?${params.toString()}`;
}

// Learn the total file size from a 1-byte ranged request, so we can map a
// playback position to a byte offset when the item metadata lacks Size/Bitrate.
async function probeStreamSize(url: string, opts: { ua: string; proxyUrl?: string }): Promise<number> {
  try {
    const res = (await undiciFetch(url, {
      method: 'GET',
      headers: { 'User-Agent': opts.ua, Range: 'bytes=0-0' },
      dispatcher: opts.proxyUrl ? new ProxyAgent(opts.proxyUrl) : ipv4Agent,
    } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
    const contentRange = res.headers.get('content-range');
    const contentLength = res.headers.get('content-length');
    await res.body?.cancel?.();
    if (contentRange) {
      const m = /\/(\d+)\s*$/.exec(contentRange);
      if (m) return Number(m[1]);
    }
    if (res.status === 200 && contentLength) return Number(contentLength);
    return 0;
  } catch {
    return 0;
  }
}

// Resolve the URL Real Watch streams from. Prefer the static direct-play route;
// fall back to the direct-stream URL PlaybackInfo advertises for setups where a
// proxy only routes that form.
async function resolveRealStreamUrl(
  baseUrl: string,
  itemId: string,
  mediaSourceId: string,
  opts: { token: string; ua: string; userId: string; deviceName: string; proxyUrl?: string; playSessionId: string; deviceId: string }
): Promise<{ url: string; size: number } | undefined> {
  const staticUrl = buildStaticStreamUrl(baseUrl, itemId, mediaSourceId, opts);
  const staticSize = await probeStreamSize(staticUrl, opts);
  if (staticSize > 0) return { url: staticUrl, size: staticSize };

  const direct = await getClientStreamUrl(baseUrl, itemId, mediaSourceId, { ...opts, directOnly: true });
  if (!direct) return undefined;
  const url = /PlaySessionId=/.test(direct) ? direct : appendParam(direct, 'PlaySessionId', opts.playSessionId);
  return { url, size: await probeStreamSize(url, opts) };
}

// Download a byte range at real playback pace and discard it. Reading the body
// generates the same streaming traffic a real player would, without buffering
// the whole chunk in memory.
async function drainRange(
  url: string,
  start: number,
  end: number,
  opts: { ua: string; proxyUrl?: string }
): Promise<number> {
  const res = (await undiciFetch(url, {
    method: 'GET',
    headers: { 'User-Agent': opts.ua, Range: `bytes=${start}-${end}` },
    dispatcher: opts.proxyUrl ? new ProxyAgent(opts.proxyUrl) : ipv4Agent,
  } as Parameters<typeof undiciFetch>[1])) as unknown as Response;

  if (res.status !== 200 && res.status !== 206) {
    await res.body?.cancel?.();
    throw new Error(`stream returned ${res.status}`);
  }
  let bytes = 0;
  const reader = res.body?.getReader?.();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) bytes += value.byteLength;
    }
  }
  return bytes;
}

// A single playable unit: the raw Emby item plus the ids/runtime we need.
type Segment = { item: any; itemId: string; mediaSourceId: string; runtimeSeconds: number };

type PlayCtx = {
  token: string;
  ua: string;
  userId: string;
  deviceName: string;
  proxyUrl?: string;
  playSessionId: string;
  realWatch: boolean;
};

function toSegment(candidate: any): Segment {
  const itemId: string = candidate.Id;
  return {
    item: candidate,
    itemId,
    mediaSourceId: candidate.MediaSources?.[0]?.Id ?? itemId,
    runtimeSeconds: candidate.RunTimeTicks ? Math.floor(candidate.RunTimeTicks / TICKS_PER_SECOND) : 0,
  };
}

function reqOpts(ctx: PlayCtx) {
  return { ua: ctx.ua, token: ctx.token, deviceName: ctx.deviceName, proxyUrl: ctx.proxyUrl };
}

/** POST /Sessions/Playing → progress loop (+ Real Watch byte streaming) → /Sessions/Playing/Stopped. */
async function playSegment(
  serverUrl: string,
  ctx: PlayCtx,
  seg: Segment,
  startSeconds: number,
  watchSeconds: number,
): Promise<{ streamedBytes: number }> {
  const { itemId, mediaSourceId, item, runtimeSeconds } = seg;
  const startTicks = startSeconds * TICKS_PER_SECOND;

  await embyRequest(serverUrl, '/Sessions/Playing', {
    method: 'POST',
    ...reqOpts(ctx),
    body: {
      ItemId: itemId,
      MediaSourceId: mediaSourceId,
      PlaySessionId: ctx.playSessionId,
      PositionTicks: startTicks,
      IsPaused: false,
      CanSeek: true,
    },
  });

  // Real Watch: resolve a direct-play stream and the byte-per-second rate so each
  // interval can pull the media bytes a real client would, in step with the
  // reported position. Disabled gracefully if the rate can't be determined.
  let streamedBytes = 0;
  let streamUrl: string | undefined;
  let bytesPerSecond = 0;
  let fileSize = 0;
  if (ctx.realWatch) {
    const source = item.MediaSources?.[0];
    bytesPerSecond =
      Number(source?.Size) > 0 && runtimeSeconds > 0
        ? Number(source.Size) / runtimeSeconds
        : Number(source?.Bitrate) > 0
          ? Number(source.Bitrate) / 8
          : 0;
    fileSize = Number(source?.Size) || 0;
    const deviceId = ctx.deviceName.replace(/\s+/g, '-');
    const resolved = await resolveRealStreamUrl(serverUrl, itemId, mediaSourceId, {
      token: ctx.token,
      ua: ctx.ua,
      userId: ctx.userId,
      deviceName: ctx.deviceName,
      proxyUrl: ctx.proxyUrl,
      playSessionId: ctx.playSessionId,
      deviceId,
    });
    if (resolved) {
      streamUrl = resolved.url;
      if (resolved.size > 0) fileSize = resolved.size;
      if (bytesPerSecond === 0 && fileSize > 0 && runtimeSeconds > 0) bytesPerSecond = fileSize / runtimeSeconds;
    }
    if (!streamUrl || bytesPerSecond === 0 || fileSize === 0) {
      console.warn('[embywatch] Real Watch: could not resolve a streamable direct-play URL/bitrate, streaming disabled for this segment');
      streamUrl = undefined;
    } else {
      console.log(`[embywatch] Real Watch — ~${Math.round((bytesPerSecond * 8) / 1000)} kbps direct stream for "${item.Name}"`);
    }
  }

  const offsetAt = (sec: number): number =>
    fileSize > 0 && bytesPerSecond > 0 ? Math.min(fileSize - 1, Math.max(0, Math.floor(sec * bytesPerSecond))) : 0;

  let elapsed = 0;
  while (elapsed < watchSeconds) {
    const wait = Math.min(PROGRESS_INTERVAL_S, watchSeconds - elapsed);

    if (streamUrl) {
      // Pull this interval's byte window while waiting, so real streaming
      // traffic tracks the reported position like an actual player.
      const rangeStart = offsetAt(startSeconds + elapsed);
      const rangeEnd = Math.max(rangeStart, offsetAt(startSeconds + elapsed + wait) - 1);
      await Promise.all([
        new Promise(r => setTimeout(r, wait * 1000)),
        drainRange(streamUrl, rangeStart, rangeEnd, { ua: ctx.ua, proxyUrl: ctx.proxyUrl })
          .then(b => {
            streamedBytes += b;
          })
          .catch(e => {
            console.warn('[embywatch] Real Watch stream chunk failed:', e?.message ?? e);
          }),
      ]);
    } else {
      await new Promise(r => setTimeout(r, wait * 1000));
    }
    elapsed += wait;

    await embyRequest(serverUrl, '/Sessions/Playing/Progress', {
      method: 'POST',
      ...reqOpts(ctx),
      body: {
        ItemId: itemId,
        MediaSourceId: mediaSourceId,
        PlaySessionId: ctx.playSessionId,
        PositionTicks: startTicks + elapsed * TICKS_PER_SECOND,
        IsPaused: false,
      },
    });
  }

  await embyRequest(serverUrl, '/Sessions/Playing/Stopped', {
    method: 'POST',
    ...reqOpts(ctx),
    body: {
      ItemId: itemId,
      MediaSourceId: mediaSourceId,
      PlaySessionId: ctx.playSessionId,
      PositionTicks: (startSeconds + watchSeconds) * TICKS_PER_SECOND,
    },
  });

  return { streamedBytes };
}

async function markPlayed(serverUrl: string, ctx: PlayCtx, itemId: string): Promise<boolean> {
  try {
    await embyRequest(serverUrl, `/Users/${ctx.userId}/PlayedItems/${itemId}`, { method: 'POST', ...reqOpts(ctx) });
    return true;
  } catch (e) {
    console.warn('[embywatch] Failed to mark item as watched:', e);
    return false;
  }
}

/** First streamable segment from a candidate list, honouring verifyPlayable. */
async function firstPlayable(
  serverUrl: string,
  ctx: PlayCtx,
  candidates: any[],
  verifyPlayable: boolean,
): Promise<Segment | undefined> {
  for (const candidate of candidates) {
    const seg = toSegment(candidate);
    if (
      !verifyPlayable ||
      (await isMediaAvailable(serverUrl, seg.itemId, seg.mediaSourceId, {
        token: ctx.token,
        ua: ctx.ua,
        userId: ctx.userId,
        deviceName: ctx.deviceName,
        proxyUrl: ctx.proxyUrl,
      }))
    ) {
      return seg;
    }
    console.warn(`[embywatch] "${candidate.Name}" is not streamable — trying another item`);
  }
  return undefined;
}

/** Random streamable item (existing behaviour), retried up to MAX_PICK_ATTEMPTS. */
async function pickRandomSegment(serverUrl: string, ctx: PlayCtx, verifyPlayable: boolean): Promise<Segment | undefined> {
  const attempts = verifyPlayable ? MAX_PICK_ATTEMPTS : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const items = await embyRequest<any>(
      serverUrl,
      `/Users/${ctx.userId}/Items?SortBy=Random&Limit=1&IncludeItemTypes=Episode,Movie&Recursive=true&Fields=MediaSources,RunTimeTicks`,
      reqOpts(ctx),
    );
    if (!items.Items?.length) return undefined;
    const seg = toSegment(items.Items[0]);
    if (
      !verifyPlayable ||
      (await isMediaAvailable(serverUrl, seg.itemId, seg.mediaSourceId, {
        token: ctx.token,
        ua: ctx.ua,
        userId: ctx.userId,
        deviceName: ctx.deviceName,
        proxyUrl: ctx.proxyUrl,
      }))
    ) {
      return seg;
    }
    console.warn(`[embywatch] "${seg.item.Name}" is not streamable (attempt ${attempt}/${attempts}) — trying another item`);
  }
  return undefined;
}

/** The next episode in the series after `item`, or undefined at the series end. */
async function getNextEpisode(serverUrl: string, ctx: PlayCtx, item: any, verifyPlayable: boolean): Promise<Segment | undefined> {
  if (item.Type !== 'Episode' || !item.SeriesId) return undefined;
  const eps = await embyRequest<any>(serverUrl, `/Shows/${item.SeriesId}/Episodes?UserId=${ctx.userId}&Fields=MediaSources,RunTimeTicks`, reqOpts(ctx));
  const list: any[] = eps.Items ?? [];
  const idx = list.findIndex(e => e.Id === item.Id);
  if (idx < 0 || idx + 1 >= list.length) return undefined;
  const next = toSegment(list[idx + 1]);
  if (
    verifyPlayable &&
    !(await isMediaAvailable(serverUrl, next.itemId, next.mediaSourceId, {
      token: ctx.token,
      ua: ctx.ua,
      userId: ctx.userId,
      deviceName: ctx.deviceName,
      proxyUrl: ctx.proxyUrl,
    }))
  ) {
    return undefined;
  }
  return next;
}

// Bound the chain so a bad runtime/position can never loop forever.
const MAX_SEQUENCE_SEGMENTS = 30;

/**
 * Sequence Play: resume where the user left off (Emby "Continue Watching"),
 * else the next unwatched episode (Next Up), else a random item; then keep
 * playing the next episode each time one finishes until the play duration is
 * used up. An episode is marked watched only when it actually reaches the end,
 * so a partially-watched item stays in the resume list for next time.
 */
async function runSequencePlay(
  serverUrl: string,
  ctx: PlayCtx,
  config: EmbywatchConfig,
  opts: { playDuration: number; verifyPlayable: boolean },
): Promise<EmbywatchLog> {
  const { playDuration, verifyPlayable } = opts;

  // Pick the starting segment and position: resume → next up → random.
  let curStart = 0;
  const resume = await embyRequest<any>(
    serverUrl,
    `/Users/${ctx.userId}/Items/Resume?Limit=10&MediaTypes=Video&Recursive=true&Fields=MediaSources,RunTimeTicks`,
    reqOpts(ctx),
  );
  let cur = await firstPlayable(serverUrl, ctx, resume.Items ?? [], verifyPlayable);
  if (cur) {
    const posTicks = Number(cur.item.UserData?.PlaybackPositionTicks) || 0;
    curStart = posTicks > 0 ? Math.floor(posTicks / TICKS_PER_SECOND) : 0;
    console.log(`[embywatch] Sequence Play: resuming "${cur.item.Name}" at ${curStart}s`);
  } else {
    const nextUp = await embyRequest<any>(serverUrl, `/Shows/NextUp?UserId=${ctx.userId}&Limit=10&Fields=MediaSources,RunTimeTicks`, reqOpts(ctx));
    cur = await firstPlayable(serverUrl, ctx, nextUp.Items ?? [], verifyPlayable);
    if (cur) console.log(`[embywatch] Sequence Play: starting Next Up "${cur.item.Name}"`);
  }
  if (!cur) {
    cur = await pickRandomSegment(serverUrl, ctx, verifyPlayable);
    if (cur) {
      curStart = cur.runtimeSeconds > 0 ? Math.floor(cur.runtimeSeconds * (0.05 + Math.random() * 0.05)) : 0;
      console.log(`[embywatch] Sequence Play: nothing to resume, random "${cur.item.Name}" from ${curStart}s`);
    }
  }
  if (!cur) {
    throw new Error('No streamable items found on Emby server — media may be offline (disk down); skipped reporting');
  }

  let budget = Math.floor(playDuration * (1 + Math.random() * 0.1));
  let totalStreamed = 0;
  let episodesCompleted = 0;
  let last: { seg: Segment; start: number; end: number; finished: boolean } = { seg: cur, start: curStart, end: curStart, finished: false };

  for (let i = 0; i < MAX_SEQUENCE_SEGMENTS && cur && budget > 0; i++) {
    const rt = cur.runtimeSeconds;
    const episodeRemaining = rt > 0 ? Math.max(0, rt - curStart) : budget;
    const watchSeconds = Math.min(budget, episodeRemaining);

    if (watchSeconds > 0) {
      console.log(`[embywatch] Watching "${cur.item.Name}" (${cur.item.Type}) from ${curStart}s for ${watchSeconds}s`);
      const { streamedBytes } = await playSegment(serverUrl, ctx, cur, curStart, watchSeconds);
      totalStreamed += streamedBytes;
    }

    const end = curStart + watchSeconds;
    const finished = rt > 0 && end >= Math.floor(rt * 0.99);
    last = { seg: cur, start: curStart, end, finished };
    budget -= watchSeconds;

    if (!finished) break; // budget exhausted mid-item; leave the partial in resume

    if (config.markWatched !== false) await markPlayed(serverUrl, ctx, cur.itemId);
    episodesCompleted++;
    cur = await getNextEpisode(serverUrl, ctx, cur.item, verifyPlayable);
    curStart = 0;
  }

  const seg = last.seg;
  if (ctx.realWatch) {
    console.log(`[embywatch] Real Watch streamed ${(totalStreamed / 1_048_576).toFixed(1)} MB across ${episodesCompleted} completed episode(s)`);
  }
  console.log(`[embywatch] Sequence Play complete — ${episodesCompleted} episode(s) finished, last "${seg.item.Name}"`);

  return {
    itemType: seg.item.Type ?? 'Unknown',
    title: seg.item.Name ?? 'Unknown',
    seriesName: seg.item.SeriesName,
    seasonNumber: seg.item.ParentIndexNumber,
    episodeNumber: seg.item.IndexNumber,
    runtimeSeconds: seg.runtimeSeconds,
    startSeconds: last.start,
    endSeconds: last.end,
    watchedSeconds: last.end - last.start,
    markedWatched: last.finished && config.markWatched !== false,
    streamedBytes: ctx.realWatch ? totalStreamed : undefined,
    sequencePlay: true,
    episodesCompleted,
  };
}

export async function runEmbywatch(serverUrl: string, config: EmbywatchConfig): Promise<EmbywatchLog> {
  const ua = config.userAgent ?? getSetting('default_ua') ?? DEFAULT_UA;
  const playDuration = config.playDuration ?? Number(getSetting('default_play_duration') ?? 300);
  const deviceName = resolveDeviceName(getSetting('default_device_name') ?? 'Yamby', config.username);

  const proxyUrl = resolveProxyUrl(config.proxyId);

  // 1. Authenticate
  const auth = await embyRequest<any>(serverUrl, '/Users/AuthenticateByName', {
    method: 'POST',
    ua,
    deviceName,
    proxyUrl,
    body: { Username: config.username, Pw: config.password },
  });

  const token: string = auth.AccessToken;
  const userId: string = auth.User.Id;
  console.log(`[embywatch] Authenticated as "${auth.User.Name}" on ${serverUrl}`);

  // 2. Build the play context (session id, device, streaming flag).
  const verifyPlayable = config.verifyPlayable !== false;
  const ctx: PlayCtx = {
    token,
    ua,
    userId,
    deviceName,
    proxyUrl,
    playSessionId: `bemby-${Date.now()}`,
    realWatch: config.realWatch === true,
  };

  // Sequence Play resumes and chains episodes; the default path plays one random item.
  if (config.sequencePlay === true) {
    return runSequencePlay(serverUrl, ctx, config, { playDuration, verifyPlayable });
  }

  // 3. Pick a random streamable item. When the disk is down the metadata item
  // still exists, so verifying playability avoids reporting an unplayable file.
  const picked = await pickRandomSegment(serverUrl, ctx, verifyPlayable);
  if (!picked) {
    throw new Error('No streamable items found on Emby server — media may be offline (disk down); skipped reporting');
  }
  const { item, itemId, runtimeSeconds } = picked;

  // 4. Start at a random 5-10% into the item
  const startSeconds = runtimeSeconds > 0 ? Math.floor(runtimeSeconds * (0.05 + Math.random() * 0.05)) : 0;

  // 5. Watch playDuration + 0-10% jitter, capped so we don't overshoot the end
  const actualDuration = Math.floor(playDuration * (1 + Math.random() * 0.1));
  const maxWatchable = runtimeSeconds > 0 ? Math.max(0, Math.floor(runtimeSeconds * 0.97) - startSeconds) : Infinity;
  const watchDuration = maxWatchable < Infinity ? Math.min(actualDuration, maxWatchable) : actualDuration;
  const endSeconds = startSeconds + watchDuration;

  console.log(`[embywatch] Watching "${item.Name}" (${item.Type}) from ${startSeconds}s, duration ${watchDuration}s`);

  const { streamedBytes } = await playSegment(serverUrl, ctx, picked, startSeconds, watchDuration);

  // 6. Optionally mark the item as watched (enabled by default)
  let markedWatched = false;
  if (config.markWatched !== false) markedWatched = await markPlayed(serverUrl, ctx, itemId);

  if (ctx.realWatch) {
    console.log(`[embywatch] Real Watch streamed ${(streamedBytes / 1_048_576).toFixed(1)} MB for "${item.Name}"`);
  }
  console.log(`[embywatch] Session complete for "${item.Name}" — marked watched: ${markedWatched}`);

  return {
    itemType: item.Type ?? 'Unknown',
    title: item.Name ?? 'Unknown',
    seriesName: item.SeriesName,
    seasonNumber: item.ParentIndexNumber,
    episodeNumber: item.IndexNumber,
    runtimeSeconds,
    startSeconds,
    endSeconds,
    watchedSeconds: watchDuration,
    markedWatched,
    streamedBytes: ctx.realWatch ? streamedBytes : undefined,
  };
}
