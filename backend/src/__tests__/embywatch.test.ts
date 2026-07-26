// Verify that embywatch uses the IPv4-only undici agent (no proxy) vs ProxyAgent (proxy set).
// The IPv4 agent guards against Happy Eyeballs wasting the connect timeout on broken
// IPv6 routes in container environments.

const { mockUndiciFetch, MockProxyAgent, MockAgent } = vi.hoisted(() => ({
  mockUndiciFetch: vi.fn(),
  MockProxyAgent: vi.fn(),
  MockAgent: vi.fn(),
}));

vi.mock('undici', () => ({
  fetch: mockUndiciFetch,
  ProxyAgent: MockProxyAgent,
  Agent: MockAgent,
}));

vi.mock('node:dns', () => ({ lookup: vi.fn() }));

vi.mock('../db/database', () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
    }),
  },
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '../db/database';
import { runEmbywatch } from '../jobs/embywatch';

const baseConfig = { username: 'user', password: 'pass', playDuration: 1 };

// Key-aware settings mock: returns a row only for the given keys, so e.g. the
// proxies JSON is never misread as a device-name template. `run` covers the
// device-name persistence path.
function mockSettings(settings: Record<string, string> = {}) {
  vi.mocked(db.prepare).mockReturnValue({
    get: vi.fn((key: string) => (key in settings ? { value: settings[key] } : undefined)),
    run: vi.fn(),
  } as any);
}

// Each test only needs to verify which dispatcher is used on the first request (auth).
// We let it fail after that -- no need to simulate full playback.

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings();
  mockUndiciFetch.mockRejectedValue(
    Object.assign(new Error('net'), { cause: { code: 'ECONNREFUSED' } }),
  );
});

describe('embywatch fetch routing', () => {
  it('uses the IPv4 agent (not ProxyAgent) when no proxy is configured', async () => {
    await expect(runEmbywatch('https://emby.example.com', baseConfig))
      .rejects.toThrow('Cannot reach Emby server');

    expect(mockUndiciFetch).toHaveBeenCalled();
    const dispatcher = (mockUndiciFetch.mock.calls[0][1] as any)?.dispatcher;
    // Should be the ipv4Agent instance (MockAgent), not a ProxyAgent
    expect(MockProxyAgent).not.toHaveBeenCalled();
    expect(dispatcher).toBeInstanceOf(MockAgent);
  });

  it('uses ProxyAgent when a proxy URL is resolved', async () => {
    mockSettings({
      proxies: JSON.stringify([{ id: 'p1', name: 'My Proxy', url: 'http://proxy.local:3128' }]),
    });

    await expect(runEmbywatch('https://emby.example.com', { ...baseConfig, proxyId: 'p1' }))
      .rejects.toThrow('Cannot reach Emby server');

    expect(MockProxyAgent).toHaveBeenCalledWith('http://proxy.local:3128');
    const dispatcher = (mockUndiciFetch.mock.calls[0][1] as any)?.dispatcher;
    expect(dispatcher).toBeInstanceOf(MockProxyAgent);
  });

  it('falls back to IPv4 agent when proxyId does not match any stored proxy', async () => {
    mockSettings({
      proxies: JSON.stringify([{ id: 'other', url: 'http://x' }]),
    });

    await expect(runEmbywatch('https://emby.example.com', { ...baseConfig, proxyId: 'missing' }))
      .rejects.toThrow('Cannot reach Emby server');

    expect(MockProxyAgent).not.toHaveBeenCalled();
  });

  it('wraps network errors with the full request URL and cause', async () => {
    await expect(runEmbywatch('https://emby.example.com', baseConfig))
      .rejects.toThrow('Cannot reach Emby server at https://emby.example.com/Users/AuthenticateByName — ECONNREFUSED');
  });

  it('sanitises whitespace in DeviceId but keeps the display device name', async () => {
    mockSettings({ default_device_name: 'Macbook Pro' });

    await expect(runEmbywatch('https://emby.example.com', baseConfig)).rejects.toThrow();

    const headers = (mockUndiciFetch.mock.calls[0][1] as any)?.headers;
    expect(headers['X-Emby-Authorization']).toContain('DeviceId="Macbook-Pro"');
    expect(headers['X-Emby-Authorization']).toContain('Device="Macbook Pro"');
  });

  it('surfaces HTTP error status and Emby JSON message on non-2xx response', async () => {
    mockUndiciFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: vi.fn().mockResolvedValue(JSON.stringify({ Message: 'Invalid credentials' })),
    });

    await expect(runEmbywatch('https://emby.example.com', baseConfig))
      .rejects.toThrow('Invalid credentials');
  });
});

// Routes mock responses by request URL so we can simulate auth + item pick +
// stream probe independently.
function routeFetch(
  streamStatus: number,
  opts: { directStreamUrl?: string; directStatus?: number } = {},
) {
  const jsonRes = (body: unknown) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  });
  const probeRes = (status: number) => ({
    status,
    body: { cancel: vi.fn() },
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(status === 200 || status === 206 ? 1024 : 0)),
  });
  mockUndiciFetch.mockImplementation((url: string) => {
    if (url.includes('/Users/AuthenticateByName')) {
      return Promise.resolve(jsonRes({ AccessToken: 'tok', User: { Id: 'u1', Name: 'Tester' } }));
    }
    if (url.includes('/PlaybackInfo')) {
      return Promise.resolve(jsonRes({
        MediaSources: [{ Id: 's1', DirectStreamUrl: opts.directStreamUrl }],
      }));
    }
    // DirectStreamUrl probe (the /videos/{id}/original.{container} form)
    if (url.includes('/original.')) {
      return Promise.resolve(probeRes(opts.directStatus ?? 404));
    }
    if (url.includes('/Videos/') && url.includes('/stream')) {
      return Promise.resolve(probeRes(streamStatus));
    }
    if (url.includes('/Items')) {
      return Promise.resolve(jsonRes({
        Items: [{ Id: 'i1', Name: 'Ep', Type: 'Episode', RunTimeTicks: 6000_000_000, MediaSources: [{ Id: 's1' }] }],
      }));
    }
    // Playing / Progress / Stopped / PlayedItems
    return Promise.resolve({ ok: true, status: 204, statusText: 'No Content', text: vi.fn().mockResolvedValue('') });
  });
}

describe('embywatch playability verification', () => {
  it('skips reporting when the media is offline (stream probe fails)', async () => {
    routeFetch(404);

    await expect(runEmbywatch('https://emby.example.com', baseConfig))
      .rejects.toThrow('No streamable items found');

    // No playback should have been reported.
    const reported = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/Sessions/Playing'),
    );
    expect(reported).toBe(false);
  });

  it('reports playback when the stream probe succeeds', async () => {
    routeFetch(206);

    const result = await runEmbywatch('https://emby.example.com', baseConfig);
    expect(result.title).toBe('Ep');

    const reported = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].endsWith('/Sessions/Playing'),
    );
    expect(reported).toBe(true);
  });

  it('accepts an item when the static probe fails but the PlaybackInfo DirectStreamUrl works', async () => {
    // Mirrors proxies that only route the DirectStreamUrl form and reject /stream
    routeFetch(500, { directStreamUrl: '/videos/i1/original.mkv?api_key=tok', directStatus: 206 });

    const result = await runEmbywatch('https://emby.example.com', baseConfig);
    expect(result.title).toBe('Ep');

    // The DirectStreamUrl succeeded, so the static /stream fallback is never probed
    const staticProbed = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/stream?'),
    );
    expect(staticProbed).toBe(false);
  });

  it('skips reporting when both the DirectStreamUrl and static probes fail', async () => {
    routeFetch(500, { directStreamUrl: '/videos/i1/original.mkv?api_key=tok', directStatus: 500 });

    await expect(runEmbywatch('https://emby.example.com', baseConfig))
      .rejects.toThrow('No streamable items found');
  });

  it('does not probe the stream when verifyPlayable is false', async () => {
    routeFetch(404);

    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, verifyPlayable: false });
    expect(result.title).toBe('Ep');

    const probed = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/stream'),
    );
    expect(probed).toBe(false);
  });
});

// Serves auth, item pick, a 1-byte size probe (Content-Range), and ranged data
// reads (via a getReader stream) so Real Watch can pull and count real bytes.
function routeRealWatch() {
  const jsonRes = (body: unknown) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  });
  mockUndiciFetch.mockImplementation((url: string, init: any) => {
    if (url.includes('/Users/AuthenticateByName')) {
      return Promise.resolve(jsonRes({ AccessToken: 'tok', User: { Id: 'u1', Name: 'Tester' } }));
    }
    if (url.includes('/Videos/') && url.includes('/stream')) {
      const range: string = init?.headers?.Range ?? '';
      if (range === 'bytes=0-0') {
        return Promise.resolve({
          status: 206,
          headers: { get: (h: string) => (h.toLowerCase() === 'content-range' ? 'bytes 0-0/60000000' : null) },
          body: { cancel: vi.fn() },
        });
      }
      let read = 0;
      const reader = {
        read: vi.fn(() =>
          read++ === 0
            ? Promise.resolve({ done: false, value: new Uint8Array(4096) })
            : Promise.resolve({ done: true, value: undefined }),
        ),
      };
      return Promise.resolve({ status: 206, headers: { get: () => null }, body: { getReader: () => reader } });
    }
    if (url.includes('/Items')) {
      return Promise.resolve(jsonRes({
        Items: [{ Id: 'i1', Name: 'Ep', Type: 'Episode', RunTimeTicks: 6000_000_000, MediaSources: [{ Id: 's1', Size: 60_000_000, Bitrate: 800_000 }] }],
      }));
    }
    return Promise.resolve({ ok: true, status: 204, statusText: 'No Content', text: vi.fn().mockResolvedValue('') });
  });
}

describe('embywatch Real Watch', () => {
  it('streams actual media bytes with a position-following Range request', async () => {
    routeRealWatch();

    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, realWatch: true, verifyPlayable: false });
    expect(result.streamedBytes).toBeGreaterThan(0);

    // A ranged data read (not the 1-byte size probe) hit the static stream URL,
    // carrying the play session so the transfer ties to the reported session.
    const dataFetch = mockUndiciFetch.mock.calls.find(
      c =>
        typeof c[0] === 'string' &&
        c[0].includes('/stream') &&
        c[0].includes('PlaySessionId=') &&
        (c[1] as any)?.headers?.Range &&
        !(c[1] as any).headers.Range.includes('0-0'),
    );
    expect(dataFetch).toBeTruthy();
  });

  it('does not stream bytes when Real Watch is off', async () => {
    routeRealWatch();

    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, verifyPlayable: false });
    expect(result.streamedBytes).toBeUndefined();

    const streamed = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/stream'),
    );
    expect(streamed).toBe(false);
  });
});

// Configurable Sequence Play backend: a resume list, a series episode list, and
// generic session endpoints. Runtimes are short so segments finish in one tick.
function routeSequence(opts: {
  resume?: any[];
  nextUp?: any[];
  episodes?: any[];
} = {}) {
  const jsonRes = (body: unknown) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  });
  mockUndiciFetch.mockImplementation((url: string) => {
    if (url.includes('/Users/AuthenticateByName')) {
      return Promise.resolve(jsonRes({ AccessToken: 'tok', User: { Id: 'u1', Name: 'Tester' } }));
    }
    if (url.includes('/Items/Resume')) return Promise.resolve(jsonRes({ Items: opts.resume ?? [] }));
    if (url.includes('/Shows/NextUp')) return Promise.resolve(jsonRes({ Items: opts.nextUp ?? [] }));
    if (url.includes('/Episodes')) return Promise.resolve(jsonRes({ Items: opts.episodes ?? [] }));
    if (url.includes('/Items?SortBy=Random')) {
      return Promise.resolve(jsonRes({ Items: [{ Id: 'rand', Name: 'Random', Type: 'Movie', RunTimeTicks: 20_000_000, MediaSources: [{ Id: 's' }] }] }));
    }
    // Playing / Progress / Stopped / PlayedItems
    return Promise.resolve({ ok: true, status: 204, statusText: 'No Content', text: vi.fn().mockResolvedValue('') });
  });
}

const ep = (id: string, index: number, extra: Record<string, unknown> = {}) => ({
  Id: id,
  Name: `Ep ${index}`,
  Type: 'Episode',
  SeriesId: 'series1',
  SeriesName: 'Show',
  IndexNumber: index,
  RunTimeTicks: 10_000_000, // 1s runtime so a segment finishes in one tick
  MediaSources: [{ Id: `${id}-s` }],
  ...extra,
});

describe('embywatch Sequence Play', () => {
  const seqConfig = { ...baseConfig, sequencePlay: true, verifyPlayable: false, playDuration: 5 };

  it('resumes from the last position and chains to the next episode', async () => {
    // e1 resumes near its end; episode list lets it advance to e2, then e3.
    routeSequence({
      resume: [ep('e1', 1, { UserData: { PlaybackPositionTicks: 0 } })],
      episodes: [ep('e1', 1), ep('e2', 2), ep('e3', 3)],
    });

    const result = await runEmbywatch('https://emby.example.com', seqConfig);

    expect(result.sequencePlay).toBe(true);
    // playDuration 5s over 1s episodes: e1, e2, e3 all finish (series ends at e3)
    expect(result.episodesCompleted).toBe(3);

    // Every played episode is recalled, in order, with its own watch window.
    expect(result.episodes?.map(e => e.title)).toEqual(['Ep 1', 'Ep 2', 'Ep 3']);
    expect(result.episodes?.every(e => e.watchedSeconds === 1)).toBe(true);
    expect(result.episodes?.every(e => e.markedWatched)).toBe(true);
    const total = result.episodes!.reduce((s, e) => s + e.watchedSeconds, 0);
    expect(result.watchedSeconds).toBe(total);

    const marked = mockUndiciFetch.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('/PlayedItems/'),
    );
    // Each finished episode is marked watched
    expect(marked.length).toBe(result.episodesCompleted);

    const resumed = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/Items/Resume'),
    );
    expect(resumed).toBe(true);
  });

  it('falls back to Next Up when nothing is resuming', async () => {
    routeSequence({
      resume: [],
      nextUp: [ep('n1', 4)],
      episodes: [ep('n1', 4)], // last in series, no chaining
    });

    const result = await runEmbywatch('https://emby.example.com', seqConfig);
    expect(result.title).toBe('Ep 4');
    expect(result.episodesCompleted).toBe(1);

    const usedNextUp = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/Shows/NextUp'),
    );
    expect(usedNextUp).toBe(true);
  });

  it('falls back to a random item when nothing is resuming or up next', async () => {
    routeSequence({ resume: [], nextUp: [] });

    const result = await runEmbywatch('https://emby.example.com', seqConfig);
    expect(result.title).toBe('Random');

    const usedRandom = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/Items?SortBy=Random'),
    );
    expect(usedRandom).toBe(true);
  });
});

// Model an ID-aliasing proxy: ParentId is honoured only for browsing a library's
// Series/Movies (SortBy=Random) and for scoped resume; the global Resume/NextUp
// and whole-server random are unscoped. Distinguishes the query shapes the code
// actually issues.
const jsonRes = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  text: vi.fn().mockResolvedValue(JSON.stringify(body)),
});
function routeProxy(opts: {
  views: any[];
  scopedResume?: any[]; // Items?ParentId&Filters=IsResumable (in-library resumables)
  librarySample?: any[]; // Items?ParentId&IncludeItemTypes=Series,Movie&SortBy=Random
  episodes?: Record<string, any[]>; // /Shows/{seriesId}/Episodes
  wholeResume?: any[]; // /Items/Resume (unscoped)
  wholeRandom?: any[]; // /Items?SortBy=Random&IncludeItemTypes=Episode,Movie (unscoped)
  offlineIds?: string[]; // ids whose stream probe fails
}) {
  mockUndiciFetch.mockImplementation((url: string) => {
    if (url.includes('/Users/AuthenticateByName')) {
      return Promise.resolve(jsonRes({ AccessToken: 'tok', User: { Id: 'u1', Name: 'Tester' } }));
    }
    if (url.includes('/Views')) return Promise.resolve(jsonRes({ Items: opts.views }));
    if (url.includes('/PlaybackInfo')) return Promise.resolve(jsonRes({ MediaSources: [{ Id: 's' }] }));
    const vid = url.match(/\/Videos\/([^/]+)\/stream/);
    if (vid) {
      const bad = (opts.offlineIds ?? []).includes(vid[1]);
      return Promise.resolve({ status: bad ? 404 : 206, body: { cancel: vi.fn() }, arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(bad ? 0 : 1024)) });
    }
    if (url.includes('Filters=IsResumable')) return Promise.resolve(jsonRes({ Items: opts.scopedResume ?? [] }));
    if (url.includes('IncludeItemTypes=Series,Movie')) return Promise.resolve(jsonRes({ Items: opts.librarySample ?? [] }));
    const eps = url.match(/\/Shows\/([^/]+)\/Episodes/);
    if (eps) return Promise.resolve(jsonRes({ Items: opts.episodes?.[eps[1]] ?? [] }));
    if (url.includes('/Items/Resume')) return Promise.resolve(jsonRes({ Items: opts.wholeResume ?? [] }));
    if (url.includes('/Shows/NextUp')) return Promise.resolve(jsonRes({ Items: [] }));
    if (url.includes('SortBy=Random')) return Promise.resolve(jsonRes({ Items: opts.wholeRandom ?? [] }));
    return Promise.resolve({ ok: true, status: 204, statusText: 'No Content', text: vi.fn().mockResolvedValue('') });
  });
}

describe('embywatch library scoping', () => {
  const views = [{ Id: 'lib-movies', Name: 'Movies' }, { Id: 'lib-tv', Name: 'TV Shows' }];
  const series = (id: string, name: string) => ({ Id: id, Name: name, Type: 'Series', MediaSources: [{ Id: `${id}-s` }] });
  const urls = () => mockUndiciFetch.mock.calls.map(c => c[0] as string).filter(u => typeof u === 'string');

  it('scopes the random pick to the library by name, via a bounded Series/Movie browse', async () => {
    routeProxy({ views, librarySample: [series('sA', 'InLibShow')], episodes: { sA: [ep('e1', 1)] } });
    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, verifyPlayable: false, playDuration: 1, library: 'tv shows' });
    expect(result.title).toBe('Ep 1');
    const browse = urls().find(u => u.includes('IncludeItemTypes=Series,Movie'));
    expect(browse).toContain('ParentId=lib-tv');
    // Bounded: no full enumeration (small Limit, no paging).
    expect(browse).toContain('Limit=12');
    expect(urls().some(u => /Limit=(?:[5-9]\d\d|\d{4,})/.test(u) || u.includes('StartIndex='))).toBe(false);
  });

  it('scopes to a library by its 1-based index', async () => {
    routeProxy({ views, librarySample: [series('sA', 'InLibShow')], episodes: { sA: [ep('e1', 1)] } });
    await runEmbywatch('https://emby.example.com', { ...baseConfig, verifyPlayable: false, playDuration: 1, library: '1' });
    expect(urls().find(u => u.includes('IncludeItemTypes=Series,Movie'))).toContain('ParentId=lib-movies');
  });

  it('ignores an unknown library and uses the whole server', async () => {
    routeProxy({ views, wholeRandom: [{ Id: 'w1', Name: 'Whole', Type: 'Movie', RunTimeTicks: 20_000_000, MediaSources: [{ Id: 's' }] }] });
    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, verifyPlayable: false, playDuration: 1, library: 'Nope' });
    expect(result.title).toBe('Whole');
    // No library browse happened.
    expect(urls().some(u => u.includes('IncludeItemTypes=Series,Movie'))).toBe(false);
  });

  it('never resumes an out-of-library item even when the global Resume list is not scoped', async () => {
    // The proxy exposes no in-library resumables, but the global Continue Watching
    // holds a drama from another library. Sequence Play must not touch it.
    routeProxy({
      views,
      scopedResume: [], // proxy: no episodes exposed under the library
      librarySample: [series('sA', 'InLibShow')],
      episodes: { sA: [ep('e1', 1)] },
      wholeResume: [{ Id: 'drama', Name: 'OutOfLib E29', Type: 'Episode', SeriesId: 'other', RunTimeTicks: 10_000_000, MediaSources: [{ Id: 'd-s' }] }],
    });
    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, sequencePlay: true, verifyPlayable: false, playDuration: 2, library: 'TV Shows' });

    expect(result.sequencePlay).toBe(true);
    expect((result.episodes ?? []).every(e => e.title.startsWith('Ep'))).toBe(true);
    expect((result.episodes ?? []).some(e => e.title.includes('OutOfLib'))).toBe(false);
    // The global (unscoped) Resume list was never consulted for the pick.
    expect(urls().some(u => u.includes('/Items/Resume'))).toBe(false);
    // The scoped resume query was bounded and library-scoped.
    expect(urls().find(u => u.includes('Filters=IsResumable'))).toContain('ParentId=lib-tv');
  });

  it('resumes an in-library item when the server honours scoped resume', async () => {
    // 60s episode resumed 30s in.
    const resumable = { ...ep('e5', 5), RunTimeTicks: 600_000_000, UserData: { PlaybackPositionTicks: 300_000_000 } };
    routeProxy({ views, scopedResume: [resumable], episodes: { series1: [ep('e5', 5), ep('e6', 6)] } });
    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, sequencePlay: true, verifyPlayable: false, playDuration: 2, library: 'TV Shows' });
    expect(result.episodes?.[0].title).toBe('Ep 5');
    expect(result.episodes?.[0].startSeconds).toBe(30); // resumed from the stored position
  });

  it('falls back to the whole server when the library has nothing to play', async () => {
    routeProxy({
      views,
      scopedResume: [],
      librarySample: [], // empty library
      wholeResume: [],
      wholeRandom: [{ Id: 'w1', Name: 'Whole', Type: 'Movie', RunTimeTicks: 20_000_000, MediaSources: [{ Id: 's' }] }],
    });
    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, sequencePlay: true, verifyPlayable: false, playDuration: 1, library: 'TV Shows' });
    expect(result.title).toBe('Whole');
  });

  it('falls back to the whole server when the library item is offline', async () => {
    routeProxy({
      views,
      librarySample: [series('sA', 'InLibShow')],
      // The stream probe keys on item id in /Videos/{id}/stream, so mark by item id.
      episodes: { sA: [{ ...ep('e1', 1), Id: 'offline', MediaSources: [{ Id: 'offline-s' }] }] },
      offlineIds: ['offline'],
      wholeRandom: [{ Id: 'good', Name: 'GoodOnServer', Type: 'Movie', RunTimeTicks: 20_000_000, MediaSources: [{ Id: 'good' }] }],
    });
    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, verifyPlayable: true, playDuration: 1, library: 'TV Shows' });
    expect(result.title).toBe('GoodOnServer');
  });
});
