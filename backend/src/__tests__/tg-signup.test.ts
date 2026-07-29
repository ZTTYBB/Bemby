// Covers the registration branch: auth.signIn reporting an unoccupied number,
// then auth.signUp creating the account and accepting the terms of service.

const { mockInvoke, mockDestroy, MockTelegramClient } = vi.hoisted(() => {
  const mockInvoke = vi.fn();
  const mockDestroy = vi.fn().mockResolvedValue(undefined);
  const MockTelegramClient = vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    invoke: mockInvoke,
    destroy: mockDestroy,
    session: { save: vi.fn().mockReturnValue('session-string') },
  }));
  return { mockInvoke, mockDestroy, MockTelegramClient };
});

vi.mock('telegram', () => {
  class TlRequest {
    constructor(public args: Record<string, unknown>) {}
  }
  const named = (className: string) =>
    class extends TlRequest {
      className = className;
    };
  return {
    TelegramClient: MockTelegramClient,
    Api: {
      auth: {
        SendCode: named('auth.SendCode'),
        SignIn: named('auth.SignIn'),
        SignUp: named('auth.SignUp'),
      },
      help: { AcceptTermsOfService: named('help.AcceptTermsOfService') },
      CodeSettings: named('codeSettings'),
    },
    Logger: vi.fn().mockReturnValue({}),
  };
});

vi.mock('telegram/sessions', () => ({
  StringSession: vi.fn().mockReturnValue({}),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestCode, submitCode, submitSignUp } from '../auth/tgAuth';

const SENT_CODE = {
  className: 'auth.SentCode',
  phoneCodeHash: 'hash123',
  type: { className: 'auth.SentCodeTypeSms', length: 5 },
};
const SIGN_UP_REQUIRED = {
  className: 'auth.AuthorizationSignUpRequired',
  termsOfService: { id: { data: 'tos-id' } },
};
const AUTHORIZED = { className: 'auth.Authorization' };

// Per-request responses, so tests do not depend on invoke call ordering.
let responses: Record<string, () => unknown>;

function callsOf(className: string) {
  return mockInvoke.mock.calls
    .map(([req]) => req)
    .filter((req) => req.className === className);
}

beforeEach(() => {
  mockInvoke.mockReset();
  mockDestroy.mockClear();
  responses = {
    'auth.SendCode': () => SENT_CODE,
    'auth.SignIn': () => SIGN_UP_REQUIRED,
    'auth.SignUp': () => AUTHORIZED,
    'help.AcceptTermsOfService': () => true,
  };
  mockInvoke.mockImplementation(async (req: { className: string }) => {
    const handler = responses[req.className];
    if (!handler) throw new Error(`unexpected request ${req.className}`);
    return handler();
  });
});

// Unique account ids per test: the pending map is module state that mock
// resets do not clear.
async function startCodeFlow(accountId: number) {
  await requestCode(accountId, 12345, 'apihash', '+61400000001');
}

describe('submitCode on an unregistered number', () => {
  it('reports needsSignUp when Telegram returns authorizationSignUpRequired', async () => {
    await startCodeFlow(201);

    const result = await submitCode(201, '12345');

    expect(result).toMatchObject({ needsSignUp: true, needsPassword: false });
    expect(result.session).toBeUndefined();
    // Client stays alive for the sign-up step
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('reports needsSignUp when the DC raises PHONE_NUMBER_UNOCCUPIED', async () => {
    await startCodeFlow(202);
    responses['auth.SignIn'] = () => {
      throw { errorMessage: 'PHONE_NUMBER_UNOCCUPIED' };
    };

    const result = await submitCode(202, '12345');

    expect(result.needsSignUp).toBe(true);
  });

  it('still returns a session for an occupied number', async () => {
    await startCodeFlow(203);
    responses['auth.SignIn'] = () => AUTHORIZED;

    const result = await submitCode(203, '12345');

    expect(result.needsSignUp).toBeUndefined();
    expect(result.session).toBe('session-string');
  });
});

describe('submitSignUp', () => {
  it('registers with the verified code hash and accepts the terms', async () => {
    await startCodeFlow(204);
    await submitCode(204, '12345');

    const session = await submitSignUp(204, ' Ada ', ' Lovelace ');

    expect(session).toBe('session-string');
    expect(callsOf('auth.SignUp')[0].args).toMatchObject({
      phoneNumber: '+61400000001',
      phoneCodeHash: 'hash123',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    expect(callsOf('help.AcceptTermsOfService')[0].args).toEqual({
      id: { data: 'tos-id' },
    });
  });

  it('skips the terms call when Telegram offered none', async () => {
    await startCodeFlow(205);
    responses['auth.SignIn'] = () => ({
      className: 'auth.AuthorizationSignUpRequired',
    });
    await submitCode(205, '12345');

    await submitSignUp(205, 'Ada');

    expect(callsOf('help.AcceptTermsOfService')).toHaveLength(0);
  });

  it('keeps the session when accepting the terms fails', async () => {
    await startCodeFlow(206);
    await submitCode(206, '12345');
    responses['help.AcceptTermsOfService'] = () => {
      throw { errorMessage: 'TOS_FAILED' };
    };

    await expect(submitSignUp(206, 'Ada')).resolves.toBe('session-string');
  });

  it('rejects an empty first name without calling Telegram', async () => {
    await startCodeFlow(207);
    await submitCode(207, '12345');
    mockInvoke.mockClear();

    await expect(submitSignUp(207, '   ')).rejects.toThrow(
      'First name is required',
    );
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('rejects when no sign-up is pending for the account', async () => {
    await expect(submitSignUp(208, 'Ada')).rejects.toThrow(
      'No pending sign-up',
    );
  });
});
