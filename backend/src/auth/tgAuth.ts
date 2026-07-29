import { TelegramClient, Api, Logger } from "telegram";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import type { TgProxy } from "../types";
import {
  invokeGetPasskeys,
  invokeDeletePasskey,
  invokeRegisterPasskey,
  invokeVerifyPasskeyLogin,
  invokePasskeyLogin,
  type Passkey,
  type RegisterPasskeyResult,
  type PasskeyLoginVerification,
} from "../tg/passkeys";
import type { PasskeySecret } from "../tg/passkeyStore";

export type TgDeviceParams = {
  deviceModel?: string;
  systemVersion?: string;
  appVersion?: string;
  langCode?: string;
  langPack?: string;
  systemLangCode?: string;
};

export type TgAccountStatus = {
  isActive: boolean;
  isDeleted: boolean;
  isRestricted: boolean;
  restrictions: Array<{ platform: string; reason: string; text: string }>;
  firstName: string;
  lastName?: string;
  username?: string;
  phone?: string;
};

type PendingAuth = {
  client: TelegramClient;
  phoneNumber: string;
  phoneCodeHash: string;
  step: "code" | "2fa" | "signup";
  // Terms of service the number must accept to register; only set on the
  // signup step, and only when Telegram returned one with the sign-up prompt.
  termsOfServiceId?: Api.TypeDataJSON;
};

// In-memory pending auth sessions keyed by account ID
const pending = new Map<number, PendingAuth>();

// Bound on the connect+sendCode round trip. GramJS's connectionRetries limits
// reconnect attempts but not total wall-clock time, so a dead/slow proxy or an
// unresponsive DC can leave the await pending forever -- which stalls the
// sequential bulk-add loop on that account. Turning the stall into a rejection
// lets callers fail the account and move on.
const REQUEST_CODE_TIMEOUT_MS = 180_000;

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// What Telegram decided to do with a code request. Surfaced to the UI and
// logged verbatim, since "no SMS arrived" is nearly always explained by the
// delivery type it picked (e.g. firebaseSms, which third-party clients cannot
// complete) rather than by an error.
export type SentCodeInfo = {
  type: string; // raw TL class, e.g. "auth.SentCodeTypeSms"
  nextType: string | null; // what a resend would use, null = no fallback offered
  timeout: number | null; // seconds before a resend is allowed
  codeLength: number | null;
  // Type-specific extras: call-pattern, missed-call prefix, email pattern,
  // firebase push timeout, sms-word/phrase beginning.
  detail: Record<string, string | number>;
};

export type SendCodeResult = {
  isCodeViaApp: boolean; // true = sent to Telegram app; false = SMS/call
  info: SentCodeInfo;
};

// Delivery types that cannot produce an SMS for a third-party client: Telegram
// expects the official app to pass an integrity/push check first.
const UNDELIVERABLE_TYPES = ["firebasesms", "setupemailrequired"];

function describeSentCode(sent: Api.auth.SentCode): SentCodeInfo {
  const type = sent.type as unknown as Record<string, unknown>;
  const detail: Record<string, string | number> = {};
  for (const key of [
    "pattern",
    "prefix",
    "emailPattern",
    "pushTimeout",
    "beginning",
    "resetAvailablePeriod",
    "resetPendingDate",
  ]) {
    const value = type?.[key];
    if (typeof value === "string" || typeof value === "number")
      detail[key] = value;
  }
  const length = type?.["length"];
  return {
    type: String(type?.className ?? "unknown"),
    nextType: sent.nextType
      ? String((sent.nextType as unknown as { className: string }).className)
      : null,
    timeout: sent.timeout ?? null,
    codeLength: typeof length === "number" ? length : null,
    detail,
  };
}

// TL objects serialise via their own toJSON (originalArgs + className); the
// BigInt guard keeps long ids from throwing.
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
  } catch (err: any) {
    return `<unserialisable: ${err?.message ?? err}>`;
  }
}

function logSentCode(
  label: string,
  accountId: number,
  info: SentCodeInfo,
  raw?: unknown,
) {
  const extras = Object.entries(info.detail)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(
    `[tgAuth] ${label} account=${accountId} deliveredVia=${info.type}` +
      ` nextType=${info.nextType ?? "none"} retryAfter=${info.timeout ?? "-"}s` +
      ` codeLength=${info.codeLength ?? "-"}${extras ? ` ${extras}` : ""}`,
  );
  // Full response, so a field this code does not map is still visible.
  if (raw !== undefined)
    console.log(`[tgAuth] ${label} raw account=${accountId} ${safeJson(raw)}`);
  // A genuine SMS dispatch normally carries both a resend timeout and a
  // nextType; neither being present usually means Telegram accepted the
  // request without actually sending anything.
  if (info.timeout == null && info.nextType == null)
    console.warn(
      `[tgAuth] ${label} account=${accountId} response declared no resend timeout` +
        ` and no fallback -- Telegram may have accepted the request without` +
        ` dispatching a message (number or api_id likely filtered)`,
    );
}

function logRpcFailure(label: string, accountId: number, err: any) {
  console.warn(
    `[tgAuth] ${label} failed account=${accountId}` +
      ` error=${err?.errorMessage ?? err?.message ?? err}` +
      ` code=${err?.code ?? "-"}`,
  );
}

// Sends the login code with the raw TL request rather than client.sendCode(),
// which discards everything except the hash and an is-this-the-app flag.
// Mirrors GramJS's AUTH_RESTART retry; DC migration is handled inside invoke().
async function invokeSendCode(
  client: TelegramClient,
  apiId: number,
  apiHash: string,
  phoneNumber: string,
  retryOnAuthRestart = true,
): Promise<Api.auth.SentCode> {
  try {
    const result = await client.invoke(
      new Api.auth.SendCode({
        phoneNumber,
        apiId,
        apiHash,
        settings: new Api.CodeSettings({}),
      }),
    );
    if (result.className === "auth.SentCodeSuccess")
      throw new Error(
        "Telegram returned an authorisation instead of a code (already signed in)",
      );
    return result as Api.auth.SentCode;
  } catch (err: any) {
    if (err?.errorMessage === "AUTH_RESTART" && retryOnAuthRestart) {
      console.warn(
        `[tgAuth] sendCode returned AUTH_RESTART for ${phoneNumber}, retrying once`,
      );
      return invokeSendCode(client, apiId, apiHash, phoneNumber, false);
    }
    throw err;
  }
}

export async function requestCode(
  accountId: number,
  apiId: number,
  apiHash: string,
  phoneNumber: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<SendCodeResult> {
  const existing = pending.get(accountId);
  if (existing) {
    await existing.client.destroy().catch(() => undefined);
    pending.delete(accountId);
  }

  // Do not pass deviceParams during auth -- desktop profiles (PC 64bit / tdesktop)
  // cause Telegram to route the code to a non-existent desktop session.
  // GramJS defaults (Android-like) have reliable SMS/app fallback.
  // The configured device profile is applied only in the live session (getLiveClient).
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 3,
    baseLogger: new Logger(LogLevel.NONE),
    ...(proxy ? { proxy } : {}),
  });
  console.log(
    `[tgAuth] requestCode account=${accountId} phone=${phoneNumber}` +
      ` apiId=${apiId} proxy=${proxy ? `${proxy.ip}:${proxy.port}` : "none"}`,
  );
  try {
    await withTimeout(client.connect(), REQUEST_CODE_TIMEOUT_MS, "connect");
    const session = client.session;
    console.log(
      `[tgAuth] connected account=${accountId} dc=${session.dcId}` +
        ` server=${session.serverAddress}:${session.port}`,
    );
    const sent = await withTimeout(
      invokeSendCode(client, apiId, apiHash, phoneNumber),
      REQUEST_CODE_TIMEOUT_MS,
      "sendCode",
    );
    const info = describeSentCode(sent);
    logSentCode("sendCode", accountId, info, sent);
    if (UNDELIVERABLE_TYPES.some((t) => info.type.toLowerCase().includes(t))) {
      console.warn(
        `[tgAuth] account=${accountId} no code will arrive: Telegram chose` +
          ` ${info.type}, which only the official app can complete.` +
          ` Fallback offered: ${info.nextType ?? "none"}`,
      );
    }
    pending.set(accountId, {
      client,
      phoneNumber,
      phoneCodeHash: sent.phoneCodeHash,
      step: "code",
    });
    return {
      isCodeViaApp: info.type.toLowerCase().includes("sentcodetypeapp"),
      info,
    };
  } catch (err) {
    logRpcFailure("sendCode", accountId, err);
    // Nothing holds a reference to this client yet — destroy it so a failed
    // send (bad/blocked number, flood-wait) doesn't leak a connected session.
    await client.destroy().catch(() => undefined);
    throw err;
  }
}

export async function resendCodeAsSms(
  accountId: number,
): Promise<SentCodeInfo> {
  const entry = pending.get(accountId);
  if (!entry || entry.step !== "code")
    throw new Error("No pending code auth for this account");
  try {
    const result = await entry.client.invoke(
      new Api.auth.ResendCode({
        phoneNumber: entry.phoneNumber,
        phoneCodeHash: entry.phoneCodeHash,
      }),
    );
    // Update the hash from the resend response
    entry.phoneCodeHash = (result as any).phoneCodeHash ?? entry.phoneCodeHash;
    const info = describeSentCode(result as Api.auth.SentCode);
    logSentCode("resendCode", accountId, info, result);
    return info;
  } catch (err) {
    logRpcFailure("resendCode", accountId, err);
    throw err;
  }
}

// Destroy and drop a parked pending-auth client. Callers that abandon an
// auth flow mid-way (e.g. bulk-add moving on after a failure) must call this,
// or the connected client leaks -- nothing else evicts it unless requestCode
// is retried for the same account id.
export async function cancelPendingAuth(accountId: number): Promise<void> {
  const entry = pending.get(accountId);
  if (!entry) return;
  pending.delete(accountId);
  await entry.client.destroy().catch(() => undefined);
}

export async function submitCode(
  accountId: number,
  code: string,
): Promise<{ needsPassword: boolean; needsSignUp?: boolean; session?: string }> {
  const entry = pending.get(accountId);
  if (!entry || entry.step !== "code")
    throw new Error("No pending code auth for this account");

  try {
    const result = await entry.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: entry.phoneNumber,
        phoneCodeHash: entry.phoneCodeHash,
        phoneCode: code,
      }),
    );

    console.log(
      `[tgAuth] signIn account=${accountId} -> ${(result as any).className}`,
    );

    // The code was valid but no account exists on this number -- Telegram is
    // asking us to register instead. Keep the client parked for submitSignUp.
    if ((result as any).className === "auth.AuthorizationSignUpRequired") {
      entry.step = "signup";
      entry.termsOfServiceId = (result as Api.auth.AuthorizationSignUpRequired)
        .termsOfService?.id;
      console.log(
        `[tgAuth] account=${accountId} number is unregistered, sign-up offered` +
          ` (terms=${entry.termsOfServiceId ? "yes" : "none"})`,
      );
      return { needsPassword: false, needsSignUp: true };
    }

    const session = entry.client.session.save() as unknown as string;
    await entry.client.destroy().catch(() => undefined);
    pending.delete(accountId);
    return { needsPassword: false, session };
  } catch (err: any) {
    if (err?.errorMessage === "SESSION_PASSWORD_NEEDED") {
      entry.step = "2fa";
      return { needsPassword: true };
    }
    // Older DCs signal an unregistered number as an error rather than with
    // auth.authorizationSignUpRequired. No ToS is offered on this path.
    if (err?.errorMessage === "PHONE_NUMBER_UNOCCUPIED") {
      entry.step = "signup";
      console.log(
        `[tgAuth] account=${accountId} number is unregistered (PHONE_NUMBER_UNOCCUPIED), sign-up offered`,
      );
      return { needsPassword: false, needsSignUp: true };
    }
    logRpcFailure("signIn", accountId, err);
    throw err;
  }
}

// Registers a brand-new Telegram account on the pending number. Only valid
// after submitCode reported needsSignUp -- the code hash it consumes is the
// one already verified by auth.signIn.
export async function submitSignUp(
  accountId: number,
  firstName: string,
  lastName?: string,
): Promise<string> {
  const entry = pending.get(accountId);
  if (!entry || entry.step !== "signup")
    throw new Error("No pending sign-up for this account");
  if (!firstName.trim()) throw new Error("First name is required");

  try {
    const result = await entry.client.invoke(
      new Api.auth.SignUp({
        phoneNumber: entry.phoneNumber,
        phoneCodeHash: entry.phoneCodeHash,
        firstName: firstName.trim(),
        lastName: lastName?.trim() ?? "",
      }),
    );
    console.log(
      `[tgAuth] signUp account=${accountId} phone=${entry.phoneNumber}` +
        ` -> ${(result as any).className}`,
    );
  } catch (err) {
    logRpcFailure("signUp", accountId, err);
    throw err;
  }

  // Registration succeeds before the ToS is accepted, so a failure here must
  // not lose the session -- Telegram nags on next login instead.
  if (entry.termsOfServiceId) {
    await entry.client
      .invoke(
        new Api.help.AcceptTermsOfService({ id: entry.termsOfServiceId }),
      )
      .catch((err: any) =>
        console.warn(
          `[tgAuth] accepting ToS failed for account ${accountId}:`,
          err?.errorMessage ?? err?.message ?? err,
        ),
      );
  }

  const session = entry.client.session.save() as unknown as string;
  await entry.client.destroy().catch(() => undefined);
  pending.delete(accountId);
  return session;
}

// Telegram error codes that indicate a permanently banned / deactivated account
const BANNED_CODES = [
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN",
  "PHONE_NUMBER_BANNED",
];

// Telegram error codes that indicate a frozen or revoked session
const FROZEN_CODES = [
  "ACCOUNT_FROZEN",
  "AUTH_KEY_UNREGISTERED",
  "SESSION_REVOKED",
  "AUTH_KEY_DUPLICATED",
];

const FROZEN_TEXT: Record<string, string> = {
  ACCOUNT_FROZEN: "Account is frozen by Telegram",
  AUTH_KEY_UNREGISTERED:
    "Session revoked — account may have been banned or logged out everywhere",
  SESSION_REVOKED: "Session was explicitly revoked",
  AUTH_KEY_DUPLICATED: "Auth key duplicated — session is no longer valid",
};

export async function checkAccountStatus(
  apiId: number,
  apiHash: string,
  sessionString: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<TgAccountStatus> {
  const client = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    {
      connectionRetries: 3,
      baseLogger: new Logger(LogLevel.NONE),
      ...(proxy ? { proxy } : {}),
      ...(deviceParams ?? {}),
    },
  );

  try {
    await client.connect();
    const me = await client.getMe();

    // UserEmpty or null — account deleted / inaccessible
    if (!me || (me as any).className === "UserEmpty") {
      return {
        isActive: false,
        isDeleted: true,
        isRestricted: false,
        restrictions: [],
        firstName: "",
      };
    }

    const user = me as Api.User;
    const isDeleted = Boolean(user.deleted);
    const isRestricted = Boolean(user.restricted);

    return {
      isActive: !isDeleted && !isRestricted,
      isDeleted,
      isRestricted,
      restrictions: (user.restrictionReason ?? []).map((r) => ({
        platform: r.platform,
        reason: r.reason,
        text: r.text,
      })),
      firstName: user.firstName ?? "",
      lastName: user.lastName,
      username: user.username,
      phone: user.phone,
    };
  } catch (err: any) {
    const code: string = err?.errorMessage ?? "";

    if (BANNED_CODES.includes(code)) {
      return {
        isActive: false,
        isDeleted: true,
        isRestricted: false,
        restrictions: [
          {
            platform: "all",
            reason: "banned",
            text: `Account banned by Telegram (${code})`,
          },
        ],
        firstName: "",
      };
    }

    if (FROZEN_CODES.includes(code)) {
      return {
        isActive: false,
        isDeleted: false,
        isRestricted: true,
        restrictions: [
          {
            platform: "all",
            reason: code.toLowerCase(),
            text: FROZEN_TEXT[code] ?? code,
          },
        ],
        firstName: "",
      };
    }

    throw err;
  } finally {
    await client.destroy().catch(() => undefined);
  }
}

export async function updateTwoFa(
  apiId: number,
  apiHash: string,
  sessionString: string,
  opts: { currentPassword?: string; newPassword?: string; hint?: string },
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<void> {
  const client = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    {
      connectionRetries: 3,
      baseLogger: new Logger(LogLevel.NONE),
      ...(proxy ? { proxy } : {}),
      ...(deviceParams ?? {}),
    },
  );
  try {
    await client.connect();
    await client.updateTwoFaSettings({
      currentPassword: opts.currentPassword || undefined,
      newPassword: opts.newPassword || undefined,
      hint: opts.hint ?? "",
    });
  } finally {
    await client.destroy().catch(() => undefined);
  }
}

export type TgOwnProfile = {
  firstName: string;
  lastName: string;
  about: string;
};

// Read the account's own Telegram profile (first/last name + bio).
export async function getProfile(
  apiId: number,
  apiHash: string,
  sessionString: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<TgOwnProfile> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  try {
    await client.connect();
    const me = (await client.getMe()) as Api.User;
    const full = await client.invoke(
      new Api.users.GetFullUser({ id: new Api.InputUserSelf() }),
    );
    return {
      firstName: me?.firstName ?? "",
      lastName: me?.lastName ?? "",
      about: full.fullUser.about ?? "",
    };
  } finally {
    await client.destroy().catch(() => undefined);
  }
}

// Update the account's own Telegram profile. Empty strings clear the field.
export async function updateProfile(
  apiId: number,
  apiHash: string,
  sessionString: string,
  opts: { firstName: string; lastName?: string; about?: string },
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<TgOwnProfile> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  try {
    await client.connect();
    await client.invoke(
      new Api.account.UpdateProfile({
        firstName: opts.firstName,
        lastName: opts.lastName ?? "",
        about: opts.about ?? "",
      }),
    );
    const me = (await client.getMe()) as Api.User;
    return {
      firstName: me?.firstName ?? "",
      lastName: me?.lastName ?? "",
      about: opts.about ?? "",
    };
  } finally {
    await client.destroy().catch(() => undefined);
  }
}

export type SessionInfo = {
  hash: string;
  current: boolean;
  deviceModel: string;
  platform: string;
  systemVersion: string;
  appName: string;
  appVersion: string;
  dateCreated: number;
  dateActive: number;
  ip: string;
  country: string;
  region: string;
};

export async function getSessions(
  apiId: number,
  apiHash: string,
  sessionString: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<SessionInfo[]> {
  const client = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    {
      connectionRetries: 3,
      baseLogger: new Logger(LogLevel.NONE),
      ...(proxy ? { proxy } : {}),
      ...(deviceParams ?? {}),
    },
  );
  try {
    await client.connect();
    const result = await client.invoke(new Api.account.GetAuthorizations());
    return result.authorizations.map((a) => ({
      hash: a.hash.toString(),
      current: Boolean(a.current),
      deviceModel: a.deviceModel,
      platform: a.platform,
      systemVersion: a.systemVersion,
      appName: a.appName,
      appVersion: a.appVersion,
      dateCreated: a.dateCreated,
      dateActive: a.dateActive,
      ip: a.ip,
      country: a.country,
      region: a.region,
    }));
  } finally {
    await client.destroy().catch(() => undefined);
  }
}

export async function terminateSession(
  apiId: number,
  apiHash: string,
  sessionString: string,
  hash: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<void> {
  const client = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    {
      connectionRetries: 3,
      baseLogger: new Logger(LogLevel.NONE),
      ...(proxy ? { proxy } : {}),
      ...(deviceParams ?? {}),
    },
  );
  try {
    await client.connect();
    await client.invoke(new Api.account.ResetAuthorization({ hash: BigInt(hash) as any }));
  } finally {
    await client.destroy().catch(() => undefined);
  }
}

export async function terminateOtherSessions(
  apiId: number,
  apiHash: string,
  sessionString: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<void> {
  const client = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    {
      connectionRetries: 3,
      baseLogger: new Logger(LogLevel.NONE),
      ...(proxy ? { proxy } : {}),
      ...(deviceParams ?? {}),
    },
  );
  try {
    await client.connect();
    await client.invoke(new Api.auth.ResetAuthorizations());
  } finally {
    await client.destroy().catch(() => undefined);
  }
}

export async function submitPassword(
  accountId: number,
  password: string,
): Promise<string> {
  const entry = pending.get(accountId);
  if (!entry || entry.step !== "2fa")
    throw new Error("No pending 2FA for this account");

  // Dynamic import to avoid issues with module resolution
  const { computeCheck } = await import("telegram/Password");
  const passwordInfo = await entry.client.invoke(new Api.account.GetPassword());
  const passwordSrp = await computeCheck(passwordInfo, password);
  await entry.client.invoke(
    new Api.auth.CheckPassword({ password: passwordSrp }),
  );

  const session = entry.client.session.save() as unknown as string;
  await entry.client.destroy().catch(() => undefined);
  pending.delete(accountId);
  return session;
}

// ── Recovery email management ─────────────────────────────────────────────────

export type PasswordInfo = {
  hasPassword: boolean;
  hasRecovery: boolean;
  hint: string | null;
  emailUnconfirmedPattern: string | null;
  loginEmailPattern: string | null;
};

function makeTgClient(
  sessionString: string,
  apiId: number,
  apiHash: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
) {
  return new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 3,
    baseLogger: new Logger(LogLevel.NONE),
    ...(proxy ? { proxy } : {}),
    ...(deviceParams ?? {}),
  });
}

/** Returns the account's own Telegram numeric user id as a string. */
export async function getSelfId(
  apiId: number,
  apiHash: string,
  sessionString: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<string> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  try {
    await client.connect();
    const me = await client.getMe();
    const id = (me as { id?: unknown } | null)?.id;
    if (id === undefined || id === null)
      throw new Error("Could not resolve Telegram user id");
    return String(id);
  } finally {
    await client.destroy().catch(() => undefined);
  }
}

export async function getPasswordInfo(
  apiId: number,
  apiHash: string,
  sessionString: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<PasswordInfo> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  try {
    await client.connect();
    const pwd = await client.invoke(new Api.account.GetPassword());
    return {
      hasPassword: Boolean(pwd.hasPassword),
      hasRecovery: Boolean(pwd.hasRecovery),
      hint: pwd.hint ?? null,
      emailUnconfirmedPattern: pwd.emailUnconfirmedPattern ?? null,
      loginEmailPattern: pwd.loginEmailPattern ?? null,
    };
  } finally {
    await client.destroy().catch(() => undefined);
  }
}

// ── Login email management ────────────────────────────────────────────────────
// The masked pattern comes from account.getPassword (loginEmailPattern).
// Setting or replacing uses SendVerifyEmailCode + VerifyEmail with the
// emailVerifyPurposeLoginChange purpose. Telegram provides no method to remove
// a login email from an authorised session -- it can only be replaced.

/** Send a verification code to a new login email address. */
export async function sendLoginEmailCode(
  apiId: number,
  apiHash: string,
  sessionString: string,
  email: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<{ emailPattern: string; codeLength: number }> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  try {
    await client.connect();
    // GramJS bug: EntityCache.add treats any response with a numeric `length`
    // field as array-like, and account.SentEmailCode has one (the code length),
    // so invoke() crashes with "entities is not iterable" after a successful RPC.
    // The response carries no entities, so disable caching on this throwaway client.
    (client as unknown as { _entityCache: { add: (e: unknown) => void } })
      ._entityCache.add = () => undefined;
    const sent = await client.invoke(
      new Api.account.SendVerifyEmailCode({
        purpose: new Api.EmailVerifyPurposeLoginChange(),
        email,
      }),
    );
    return { emailPattern: sent.emailPattern, codeLength: sent.length };
  } finally {
    await client.destroy().catch(() => undefined);
  }
}

/** Verify the code sent by sendLoginEmailCode, committing the new login email. */
export async function verifyLoginEmail(
  apiId: number,
  apiHash: string,
  sessionString: string,
  code: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<{ email: string | null }> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  try {
    await client.connect();
    const verified = await client.invoke(
      new Api.account.VerifyEmail({
        purpose: new Api.EmailVerifyPurposeLoginChange(),
        verification: new Api.EmailVerificationCode({ code }),
      }),
    );
    return { email: "email" in verified ? (verified.email ?? null) : null };
  } finally {
    await client.destroy().catch(() => undefined);
  }
}

// ── Passkeys ──────────────────────────────────────────────────────────────────
// Uses raw TL requests (see tg/passkeys.ts) since GramJS lacks passkey types.

export async function getPasskeys(
  apiId: number,
  apiHash: string,
  sessionString: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<Passkey[]> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  try {
    await client.connect();
    return await invokeGetPasskeys(client);
  } finally {
    await client.destroy().catch(() => undefined);
  }
}

export async function deletePasskey(
  apiId: number,
  apiHash: string,
  sessionString: string,
  passkeyId: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<boolean> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  try {
    await client.connect();
    return await invokeDeletePasskey(client, passkeyId);
  } finally {
    await client.destroy().catch(() => undefined);
  }
}

// Experimental: registers a new passkey by running the WebAuthn ceremony in Node
// (no browser). Returns the private key material for a possible future login.
export async function registerPasskey(
  apiId: number,
  apiHash: string,
  sessionString: string,
  originOverride?: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<RegisterPasskeyResult> {
  const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
  try {
    await client.connect();
    return await invokeRegisterPasskey(client, originOverride);
  } finally {
    await client.destroy().catch(() => undefined);
  }
}

// Verifies a stored passkey by logging in with it on a fresh (empty) session.
// Passkey login is DC-specific: it must run on the DC where the account lives, so
// we pin the fresh session to the authorised session's DC (avoids the cross-DC
// finishPasskeyLogin path, which otherwise fails as PASSKEY_CHALLENGE_EXPIRED).
export async function verifyPasskeyLogin(
  apiId: number,
  apiHash: string,
  accountSessionString: string,
  secret: PasskeySecret,
  originOverride?: string,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
): Promise<PasskeyLoginVerification> {
  const authed = new StringSession(accountSessionString);
  const fresh = new StringSession("");
  fresh.setDC(authed.dcId, authed.serverAddress, authed.port);
  const client = new TelegramClient(fresh, apiId, apiHash, {
    connectionRetries: 3,
    baseLogger: new Logger(LogLevel.NONE),
    ...(proxy ? { proxy } : {}),
    ...(deviceParams ?? {}),
  });
  try {
    await client.connect();
    return await invokeVerifyPasskeyLogin(
      client,
      apiId,
      apiHash,
      secret,
      originOverride,
    );
  } finally {
    await client.destroy().catch(() => undefined);
  }
}

// Reads the account's home DC out of an authorised session string.
export function getSessionDc(
  sessionString: string,
): { dcId: number; serverAddress: string; port: number } | null {
  if (!sessionString) return null;
  try {
    const s = new StringSession(sessionString);
    if (s.dcId == null || !s.serverAddress || s.port == null) return null;
    return { dcId: s.dcId, serverAddress: s.serverAddress, port: s.port };
  } catch {
    return null;
  }
}

// Logs in using a stored passkey as the first factor. On success without 2FA the
// session is returned; when the account has a cloud password, the connected client
// is parked in `pending` (step "2fa") so submitPassword() finishes it exactly like
// the code flow. Throws (caller falls back to code login) if the passkey is rejected.
export async function startPasskeyLogin(
  accountId: number,
  apiId: number,
  apiHash: string,
  secret: PasskeySecret,
  originOverride?: string,
  proxy?: TgProxy,
): Promise<{ needsPassword: boolean; session?: string }> {
  const existing = pending.get(accountId);
  if (existing) {
    await existing.client.destroy().catch(() => undefined);
    pending.delete(accountId);
  }

  const fresh = new StringSession("");
  if (secret.dcId != null && secret.serverAddress && secret.port != null) {
    fresh.setDC(secret.dcId, secret.serverAddress, secret.port);
  }
  // No deviceParams during auth (same rationale as requestCode).
  const client = new TelegramClient(fresh, apiId, apiHash, {
    connectionRetries: 3,
    baseLogger: new Logger(LogLevel.NONE),
    ...(proxy ? { proxy } : {}),
  });

  try {
    await client.connect();
    try {
      await invokePasskeyLogin(client, apiId, apiHash, secret, originOverride);
    } catch (err: any) {
      const msg = err?.errorMessage ?? err?.message ?? "";
      if (msg.includes("SESSION_PASSWORD_NEEDED")) {
        // Keep the client alive for the 2FA step.
        pending.set(accountId, {
          client,
          phoneNumber: "",
          phoneCodeHash: "",
          step: "2fa",
        });
        return { needsPassword: true };
      }
      throw err;
    }
    const session = client.session.save() as unknown as string;
    await client.destroy().catch(() => undefined);
    return { needsPassword: false, session };
  } catch (err) {
    await client.destroy().catch(() => undefined);
    throw err;
  }
}
