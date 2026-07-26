import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';
import { lookup } from 'node:dns';
import { db } from '../db/database';
import type { EmbywatchConfig, EmbywatchEpisode, EmbywatchLog } from '../types';
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

/**
 * Resolve a configured library (name or 1-based index) to its Emby id. Returns
 * undefined when blank or unmatched, so callers fall back to the whole server.
 */
async function resolveLibraryId(serverUrl: string, ctx: PlayCtx, library?: string): Promise<string | undefined> {
  const raw = (library ?? '').trim();
  if (!raw) return undefined;
  try {
    const views = await embyRequest<any>(serverUrl, `/Users/${ctx.userId}/Views`, reqOpts(ctx));
    const items: any[] = views.Items ?? [];
    // Name match first, so a library literally named "4" wins over index 4.
    const byName = items.find(v => (v.Name ?? '').trim().toLowerCase() === raw.toLowerCase());
    if (byName) return byName.Id;
    if (/^\d+$/.test(raw)) {
      const idx = Number(raw) - 1; // 1-based
      if (idx >= 0 && idx < items.length) return items[idx].Id;
    }
    console.warn(`[embywatch] Library "${raw}" not found — using the whole server`);
    return undefined;
  } catch (e) {
    console.warn('[embywatch] Failed to list libraries, using the whole server:', e);
    return undefined;
  }
}

// Library scoping notes: some servers (and ID-aliasing proxies) ignore ParentId
// on Resume/NextUp and on any item-selector query (Ids, SearchTerm, Filters), and
// won't recurse to Episodes under a library. Only plain ParentId *browsing* of a
// library's Series/Movies is reliable. So we never enumerate the whole library
// (that reads like scraping) — we take a small random sample to pick from, and
// scoped resume returns only in-library resumables (or nothing), never the global
// Continue Watching list.
const LIBRARY_SAMPLE_SIZE = 12;

async function available(serverUrl: string, ctx: PlayCtx, seg: Segment): Promise<boolean> {
  return isMediaAvailable(serverUrl, seg.itemId, seg.mediaSourceId, {
    token: ctx.token,
    ua: ctx.ua,
    userId: ctx.userId,
    deviceName: ctx.deviceName,
    proxyUrl: ctx.proxyUrl,
  });
}

/** A bounded random sample of a library's Series/Movies (no full enumeration). */
async function librarySample(serverUrl: string, ctx: PlayCtx, parentId: string, limit: number): Promise<any[]> {
  try {
    const page = await embyRequest<any>(
      serverUrl,
      `/Users/${ctx.userId}/Items?ParentId=${parentId}&Recursive=true&IncludeItemTypes=Series,Movie&SortBy=Random&Limit=${limit}&Fields=MediaSources,RunTimeTicks`,
      reqOpts(ctx),
    );
    return page.Items ?? [];
  } catch {
    return [];
  }
}

/** Expand a library member to a segment: a Series → a random episode; a Movie as-is. */
async function memberToSegment(serverUrl: string, ctx: PlayCtx, member: any): Promise<Segment | undefined> {
  if (member.Type !== 'Series') return toSegment(member);
  const eps = await embyRequest<any>(serverUrl, `/Shows/${member.Id}/Episodes?UserId=${ctx.userId}&Fields=MediaSources,RunTimeTicks`, reqOpts(ctx));
  const list: any[] = eps.Items ?? [];
  if (!list.length) return undefined;
  return toSegment(list[Math.floor(Math.random() * list.length)]);
}

// Pick a random streamable segment from within a library, using a bounded sample.
async function pickRandomFromLibrary(serverUrl: string, ctx: PlayCtx, parentId: string, verifyPlayable: boolean): Promise<Segment | undefined> {
  const sample = await librarySample(serverUrl, ctx, parentId, LIBRARY_SAMPLE_SIZE);
  const maxAttempts = Math.min(sample.length, verifyPlayable ? MAX_PICK_ATTEMPTS : 1);
  const tried = new Set<number>();
  for (let attempt = 0; attempt < maxAttempts && tried.size < sample.length; attempt++) {
    let idx = Math.floor(Math.random() * sample.length);
    while (tried.has(idx)) idx = (idx + 1) % sample.length;
    tried.add(idx);
    const seg = await memberToSegment(serverUrl, ctx, sample[idx]);
    if (!seg) continue;
    if (!verifyPlayable || (await available(serverUrl, ctx, seg))) return seg;
    console.warn(`[embywatch] "${seg.item.Name}" is not streamable — trying another library item`);
  }
  return undefined;
}

// In-library resume: scoped resumable items with a real playback position. Works
// on servers that honour ParentId; returns nothing on proxies that don't expose
// episodes under a library — so we never resume an out-of-library item.
// A series' ParentId is its library, which is the reliable, bounded membership
// signal (Ids/SearchTerm/ParentId-intersection queries are ignored by aliasing
// proxies). Cached per run so each series is fetched at most once.
async function libraryOfSeries(serverUrl: string, ctx: PlayCtx, seriesId: string, cache: Map<string, string | undefined>): Promise<string | undefined> {
  if (cache.has(seriesId)) return cache.get(seriesId);
  let parent: string | undefined;
  try {
    const s = await embyRequest<any>(serverUrl, `/Users/${ctx.userId}/Items/${seriesId}?Fields=ParentId`, reqOpts(ctx));
    parent = s?.ParentId;
  } catch {
    parent = undefined;
  }
  cache.set(seriesId, parent);
  return parent;
}

async function itemInLibrary(serverUrl: string, ctx: PlayCtx, item: any, libraryId: string, cache: Map<string, string | undefined>): Promise<boolean> {
  if (!item) return false;
  if (item.ParentId === libraryId) return true; // movie directly under the library
  const seriesId = item.Type === 'Episode' ? item.SeriesId : item.Id;
  if (!seriesId) return false;
  return (await libraryOfSeries(serverUrl, ctx, seriesId, cache)) === libraryId;
}

// In-library resume: the global Continue Watching list (which the proxy returns
// unscoped) filtered to the target library by each item's series ParentId. This
// is what lets us resume the right in-library show without scanning the library.
async function libraryResumeSegment(serverUrl: string, ctx: PlayCtx, parentId: string, verifyPlayable: boolean): Promise<Segment | undefined> {
  let res: any;
  try {
    res = await embyRequest<any>(
      serverUrl,
      `/Users/${ctx.userId}/Items/Resume?Limit=25&MediaTypes=Video&Recursive=true&Fields=MediaSources,RunTimeTicks,UserData,ParentId`,
      reqOpts(ctx),
    );
  } catch {
    return undefined;
  }
  const cache = new Map<string, string | undefined>();
  for (const cand of res.Items ?? []) {
    if (Number(cand.UserData?.PlaybackPositionTicks) <= 0) continue;
    if (!(await itemInLibrary(serverUrl, ctx, cand, parentId, cache))) continue;
    const seg = toSegment(cand);
    if (!verifyPlayable || (await available(serverUrl, ctx, seg))) return seg;
  }
  return undefined;
}

/** Random streamable item (existing behaviour), retried up to MAX_PICK_ATTEMPTS. */
async function pickRandomSegment(serverUrl: string, ctx: PlayCtx, verifyPlayable: boolean, parentId?: string): Promise<Segment | undefined> {
  const attempts = verifyPlayable ? MAX_PICK_ATTEMPTS : 1;
  const scope = parentId ? `&ParentId=${parentId}` : '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const items = await embyRequest<any>(
      serverUrl,
      `/Users/${ctx.userId}/Items?SortBy=Random&Limit=1&IncludeItemTypes=Episode,Movie&Recursive=true&Fields=MediaSources,RunTimeTicks${scope}`,
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
  opts: { playDuration: number; verifyPlayable: boolean; parentId?: string },
): Promise<EmbywatchLog> {
  const { playDuration, verifyPlayable, parentId } = opts;

  const asResume = (seg: Segment): { seg: Segment; start: number } => {
    const posTicks = Number(seg.item.UserData?.PlaybackPositionTicks) || 0;
    const start = posTicks > 0 ? Math.floor(posTicks / TICKS_PER_SECOND) : 0;
    console.log(`[embywatch] Sequence Play: resuming "${seg.item.Name}" at ${start}s`);
    return { seg, start };
  };
  const asRandom = (seg: Segment, label: string): { seg: Segment; start: number } => {
    const start = seg.runtimeSeconds > 0 ? Math.floor(seg.runtimeSeconds * (0.05 + Math.random() * 0.05)) : 0;
    console.log(`[embywatch] Sequence Play: ${label} "${seg.item.Name}" from ${start}s`);
    return { seg, start };
  };

  // Pick within the library (bounded, no full scan). Resume is scoped and only
  // kept when it has a real playback position; otherwise start a random title.
  const pickInLibrary = async (lib: string): Promise<{ seg: Segment; start: number } | undefined> => {
    const resumeSeg = await libraryResumeSegment(serverUrl, ctx, lib, verifyPlayable);
    if (resumeSeg) return asResume(resumeSeg);
    const seg = await pickRandomFromLibrary(serverUrl, ctx, lib, verifyPlayable);
    return seg ? asRandom(seg, 'nothing to resume, random from library') : undefined;
  };

  // Whole-server selection (no library scope): resume → next up → random.
  const pickWholeServer = async (): Promise<{ seg: Segment; start: number } | undefined> => {
    const resume = await embyRequest<any>(
      serverUrl,
      `/Users/${ctx.userId}/Items/Resume?Limit=10&MediaTypes=Video&Recursive=true&Fields=MediaSources,RunTimeTicks`,
      reqOpts(ctx),
    );
    let seg = await firstPlayable(serverUrl, ctx, resume.Items ?? [], verifyPlayable);
    if (seg) return asResume(seg);
    const nextUp = await embyRequest<any>(serverUrl, `/Shows/NextUp?UserId=${ctx.userId}&Limit=10&Fields=MediaSources,RunTimeTicks`, reqOpts(ctx));
    seg = await firstPlayable(serverUrl, ctx, nextUp.Items ?? [], verifyPlayable);
    if (seg) {
      console.log(`[embywatch] Sequence Play: starting Next Up "${seg.item.Name}"`);
      return { seg, start: 0 };
    }
    seg = await pickRandomSegment(serverUrl, ctx, verifyPlayable);
    return seg ? asRandom(seg, 'nothing to resume, random') : undefined;
  };

  let started = parentId ? await pickInLibrary(parentId) : await pickWholeServer();
  // If the chosen library has nothing to play, fall back to the whole server.
  if (!started && parentId) {
    console.warn('[embywatch] Sequence Play: library has nothing to play — falling back to the whole server');
    started = await pickWholeServer();
  }
  if (!started) {
    throw new Error('No streamable items found on Emby server — media may be offline (disk down); skipped reporting');
  }
  let cur: Segment | undefined = started.seg;
  let curStart = started.start;

  let budget = Math.floor(playDuration * (1 + Math.random() * 0.1));
  let totalStreamed = 0;
  let episodesCompleted = 0;
  const episodes: EmbywatchEpisode[] = [];

  for (let i = 0; i < MAX_SEQUENCE_SEGMENTS && cur && budget > 0; i++) {
    const rt = cur.runtimeSeconds;
    const episodeRemaining = rt > 0 ? Math.max(0, rt - curStart) : budget;
    const watchSeconds = Math.min(budget, episodeRemaining);

    let segStreamed = 0;
    if (watchSeconds > 0) {
      console.log(`[embywatch] Watching "${cur.item.Name}" (${cur.item.Type}) from ${curStart}s for ${watchSeconds}s`);
      const played = await playSegment(serverUrl, ctx, cur, curStart, watchSeconds);
      segStreamed = played.streamedBytes;
      totalStreamed += segStreamed;
    }

    const end = curStart + watchSeconds;
    const finished = rt > 0 && end >= Math.floor(rt * 0.99);
    budget -= watchSeconds;

    // Mark watched only when the episode actually reached its end.
    let marked = false;
    if (finished && config.markWatched !== false) marked = await markPlayed(serverUrl, ctx, cur.itemId);
    if (finished) episodesCompleted++;

    // Record every segment that actually played (skip zero-length resume-at-end hops).
    if (watchSeconds > 0) {
      episodes.push({
        itemType: cur.item.Type ?? 'Unknown',
        title: cur.item.Name ?? 'Unknown',
        seriesName: cur.item.SeriesName,
        seasonNumber: cur.item.ParentIndexNumber,
        episodeNumber: cur.item.IndexNumber,
        runtimeSeconds: rt,
        startSeconds: curStart,
        endSeconds: end,
        watchedSeconds: watchSeconds,
        markedWatched: marked,
        streamedBytes: ctx.realWatch ? segStreamed : undefined,
      });
    }

    if (!finished) break; // budget exhausted mid-item; leave the partial in resume
    cur = await getNextEpisode(serverUrl, ctx, cur.item, verifyPlayable);
    curStart = 0;
  }

  // Fall back to a placeholder entry if nothing ever played (e.g. runtime unknown
  // and budget 0), so the log always has a top-level item.
  const totalWatched = episodes.reduce((s, e) => s + e.watchedSeconds, 0);
  const head = episodes[episodes.length - 1] ?? {
    itemType: 'Unknown',
    title: 'Unknown',
    runtimeSeconds: 0,
    startSeconds: 0,
    endSeconds: 0,
    watchedSeconds: 0,
    markedWatched: false,
  };

  if (ctx.realWatch) {
    console.log(`[embywatch] Real Watch streamed ${(totalStreamed / 1_048_576).toFixed(1)} MB across ${episodes.length} segment(s)`);
  }
  console.log(`[embywatch] Sequence Play complete — ${episodes.length} segment(s), ${episodesCompleted} finished, ${totalWatched}s total`);

  return {
    ...head,
    // watchedSeconds reflects the whole sequence so the total matches playDuration
    watchedSeconds: totalWatched,
    streamedBytes: ctx.realWatch ? totalStreamed : undefined,
    sequencePlay: true,
    episodesCompleted,
    episodes,
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

  // Optionally scope everything to one library (name or 1-based index).
  const parentId = await resolveLibraryId(serverUrl, ctx, config.library);
  if (parentId) console.log(`[embywatch] Scoped to library "${config.library}"`);

  // Sequence Play resumes and chains episodes; the default path plays one random item.
  if (config.sequencePlay === true) {
    return runSequencePlay(serverUrl, ctx, config, { playDuration, verifyPlayable, parentId });
  }

  // 3. Pick a random streamable item. When the disk is down the metadata item
  // still exists, so verifying playability avoids reporting an unplayable file.
  let picked = parentId
    ? await pickRandomFromLibrary(serverUrl, ctx, parentId, verifyPlayable)
    : await pickRandomSegment(serverUrl, ctx, verifyPlayable);
  // If the chosen library has nothing to play, fall back to the whole server.
  if (!picked && parentId) {
    console.warn('[embywatch] Library has nothing to play — falling back to the whole server');
    picked = await pickRandomSegment(serverUrl, ctx, verifyPlayable);
  }
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
