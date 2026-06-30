import { TelegramClient, Api, Logger } from "telegram";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import type { TgProxy } from "../types";

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
  step: "code" | "2fa";
};

// In-memory pending auth sessions keyed by account ID
const pending = new Map<number, PendingAuth>();

export type SendCodeResult = {
  isCodeViaApp: boolean; // true = sent to Telegram app; false = SMS/call
};

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
    await existing.client.disconnect().catch(() => undefined);
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
  await client.connect();

  const sent = await client.sendCode({ apiId, apiHash }, phoneNumber);
  const isCodeViaApp = (sent as any).type?.className === "auth.SentCodeTypeApp";
  pending.set(accountId, {
    client,
    phoneNumber,
    phoneCodeHash: sent.phoneCodeHash,
    step: "code",
  });
  return { isCodeViaApp };
}

export async function resendCodeAsSms(accountId: number): Promise<void> {
  const entry = pending.get(accountId);
  if (!entry || entry.step !== "code")
    throw new Error("No pending code auth for this account");
  const result = await entry.client.invoke(
    new Api.auth.ResendCode({
      phoneNumber: entry.phoneNumber,
      phoneCodeHash: entry.phoneCodeHash,
    }),
  );
  // Update the hash from the resend response
  entry.phoneCodeHash = (result as any).phoneCodeHash ?? entry.phoneCodeHash;
}

export async function submitCode(
  accountId: number,
  code: string,
): Promise<{ needsPassword: boolean; session?: string }> {
  const entry = pending.get(accountId);
  if (!entry || entry.step !== "code")
    throw new Error("No pending code auth for this account");

  try {
    await entry.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: entry.phoneNumber,
        phoneCodeHash: entry.phoneCodeHash,
        phoneCode: code,
      }),
    );

    const session = entry.client.session.save() as unknown as string;
    await entry.client.disconnect();
    pending.delete(accountId);
    return { needsPassword: false, session };
  } catch (err: any) {
    if (err.errorMessage === "SESSION_PASSWORD_NEEDED") {
      entry.step = "2fa";
      return { needsPassword: true };
    }
    throw err;
  }
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
    const code: string = err.errorMessage ?? "";

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
    await client.disconnect().catch(() => undefined);
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
  await entry.client.disconnect();
  pending.delete(accountId);
  return session;
}
