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
