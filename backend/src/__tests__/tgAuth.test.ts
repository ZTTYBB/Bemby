// Tests that requestCode correctly forwards proxy config to TelegramClient.
// vi.hoisted ensures mock values are available inside the vi.mock() factory
// (which is hoisted to the top of the file before const declarations run).

const { mockConnect, mockSendCode, mockDisconnect, MockTelegramClient } = vi.hoisted(() => {
  const mockConnect    = vi.fn().mockResolvedValue(undefined);
  const mockSendCode   = vi.fn().mockResolvedValue({ phoneCodeHash: 'hash123' });
  const mockDisconnect = vi.fn().mockResolvedValue(undefined);
  const MockTelegramClient = vi.fn().mockReturnValue({
    connect: mockConnect,
    sendCode: mockSendCode,
    disconnect: mockDisconnect,
    session: { save: vi.fn().mockReturnValue('') },
  });
  return { mockConnect, mockSendCode, mockDisconnect, MockTelegramClient };
});

vi.mock('telegram', () => ({
  TelegramClient: MockTelegramClient,
  Api: {},
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

  it('disconnects an existing pending session before reconnecting for the same account', async () => {
    await requestCode(104, 12345, 'apihash', '+61400000001');
    vi.clearAllMocks();
    await requestCode(104, 12345, 'apihash', '+61400000001');

    // Second call must disconnect the prior session and create a fresh client
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
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
});
