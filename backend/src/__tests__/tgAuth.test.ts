// Tests that requestCode correctly forwards proxy config to TelegramClient and
// reports how Telegram delivered the code.
// vi.hoisted ensures mock values are available inside the vi.mock() factory
// (which is hoisted to the top of the file before const declarations run).

const { mockConnect, mockInvoke, mockDestroy, MockTelegramClient } = vi.hoisted(() => {
  const mockConnect    = vi.fn().mockResolvedValue(undefined);
  const mockInvoke     = vi.fn().mockResolvedValue({
    className: 'auth.SentCode',
    phoneCodeHash: 'hash123',
    type: { className: 'auth.SentCodeTypeSms', length: 5 },
    nextType: { className: 'auth.CodeTypeCall' },
    timeout: 60,
  });
  const mockDestroy    = vi.fn().mockResolvedValue(undefined);
  const MockTelegramClient = vi.fn().mockReturnValue({
    connect: mockConnect,
    invoke: mockInvoke,
    destroy: mockDestroy,
    session: { save: vi.fn().mockReturnValue('') },
  });
  return { mockConnect, mockInvoke, mockDestroy, MockTelegramClient };
});

vi.mock('telegram', () => ({
  TelegramClient: MockTelegramClient,
  Api: {
    auth: { SendCode: vi.fn().mockImplementation((args) => ({ ...args })) },
    CodeSettings: vi.fn().mockImplementation(() => ({})),
  },
  Logger: vi.fn().mockReturnValue({}),
}));

vi.mock('telegram/sessions', () => ({
  StringSession: vi.fn().mockReturnValue({}),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramClient } from 'telegram';
import { requestCode } from '../auth/tgAuth';
import type { TgProxy } from '../types';

beforeEach(() => vi.clearAllMocks());

// Each test uses a unique account ID to avoid state leakage from the module-level
// pending Map (vi.clearAllMocks does not reset module variables between tests).

describe('requestCode', () => {
  it('does not set proxy option when proxy is undefined', async () => {
    await requestCode(101, 12345, 'apihash', '+61400000001');

    const opts = vi.mocked(TelegramClient).mock.calls[0][3] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('proxy');
  });

  it('passes proxy option to TelegramClient when TgProxy is provided', async () => {
    const proxy: TgProxy = { ip: '10.0.0.1', port: 1080, socksType: 5 };
    await requestCode(102, 12345, 'apihash', '+61400000001', proxy);

    const opts = vi.mocked(TelegramClient).mock.calls[0][3] as Record<string, unknown>;
    expect(opts).toHaveProperty('proxy', proxy);
  });

  it('sets socksType correctly for SOCKS4', async () => {
    const proxy: TgProxy = { ip: '10.0.0.2', port: 1081, socksType: 4 };
    await requestCode(103, 12345, 'apihash', '+61400000001', proxy);

    const opts = vi.mocked(TelegramClient).mock.calls[0][3] as Record<string, unknown>;
    expect((opts.proxy as TgProxy).socksType).toBe(4);
  });

  it('destroys an existing pending session before reconnecting for the same account', async () => {
    await requestCode(104, 12345, 'apihash', '+61400000001');
    vi.clearAllMocks();
    await requestCode(104, 12345, 'apihash', '+61400000001');

    // Second call must destroy the prior session and create a fresh client
    expect(mockDestroy).toHaveBeenCalledTimes(1);
    expect(MockTelegramClient).toHaveBeenCalledTimes(1);
  });

  it('applies the new proxy when reconnecting with a different proxy', async () => {
    await requestCode(105, 12345, 'apihash', '+61400000001');
    vi.clearAllMocks();

    const proxy: TgProxy = { ip: '10.0.0.3', port: 1080, socksType: 5 };
    await requestCode(105, 12345, 'apihash', '+61400000001', proxy);

    const opts = vi.mocked(TelegramClient).mock.calls[0][3] as Record<string, unknown>;
    expect(opts).toHaveProperty('proxy', proxy);
  });

  it('reports the delivery type, fallback and retry timeout', async () => {
    const result = await requestCode(106, 12345, 'apihash', '+61400000001');

    expect(result.isCodeViaApp).toBe(false);
    expect(result.info).toEqual({
      type: 'auth.SentCodeTypeSms',
      nextType: 'auth.CodeTypeCall',
      timeout: 60,
      codeLength: 5,
      detail: {},
    });
  });

  it('flags a code sent to the Telegram app and keeps type-specific detail', async () => {
    mockInvoke.mockResolvedValueOnce({
      className: 'auth.SentCode',
      phoneCodeHash: 'hash999',
      type: { className: 'auth.SentCodeTypeFirebaseSms', length: 6, pushTimeout: 30 },
    });

    const result = await requestCode(107, 12345, 'apihash', '+61400000001');

    expect(result.isCodeViaApp).toBe(false);
    expect(result.info.type).toBe('auth.SentCodeTypeFirebaseSms');
    expect(result.info.nextType).toBeNull();
    expect(result.info.detail).toEqual({ pushTimeout: 30 });
  });

  it('retries once when the DC answers AUTH_RESTART', async () => {
    mockInvoke.mockRejectedValueOnce({ errorMessage: 'AUTH_RESTART' });

    const result = await requestCode(108, 12345, 'apihash', '+61400000001');

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(result.info.type).toBe('auth.SentCodeTypeSms');
  });

  it('destroys the client and rethrows when sending the code fails', async () => {
    mockInvoke.mockRejectedValue({ errorMessage: 'PHONE_NUMBER_FLOOD' });

    await expect(
      requestCode(109, 12345, 'apihash', '+61400000001'),
    ).rejects.toMatchObject({ errorMessage: 'PHONE_NUMBER_FLOOD' });
    expect(mockDestroy).toHaveBeenCalled();
  });
});
