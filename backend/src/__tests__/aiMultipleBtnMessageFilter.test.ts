// Which message the AI multi-click action is allowed to click. A captcha grid sits in one
// message among many in the same chat, so the wording filter is what stops the action
// picking a stale forum menu and clicking the wrong thing.
vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}));

import { describe, it, expect, vi } from "vitest";
import { msgTextMatches } from "../jobs/custom";
import type { Api } from "telegram";

const msg = (text: string) => ({ message: text }) as Api.Message;

const captcha = msg("🤖人机验证\n请在180秒内按照下面目标序列从 右往左 依次点击:");
const forumMenu = msg("日常 | 技术 | 情报 | 测评 | 交易");

describe("msgTextMatches", () => {
  it("takes anything when no wording is configured", () => {
    expect(msgTextMatches(captcha, undefined)).toBe(true);
    expect(msgTextMatches(forumMenu, "")).toBe(true);
    expect(msgTextMatches(forumMenu, "   ")).toBe(true);
  });

  it("keeps the captcha message and rejects the unrelated menu", () => {
    expect(msgTextMatches(captcha, "请在180秒内")).toBe(true);
    expect(msgTextMatches(forumMenu, "请在180秒内")).toBe(false);
  });

  it("ignores whitespace, so a keyword typed with spaces still matches", () => {
    expect(msgTextMatches(captcha, "请在 180 秒内")).toBe(true);
    expect(msgTextMatches(msg("Please click within 180 seconds"), "click within")).toBe(true);
  });

  it("rejects a message with no text at all", () => {
    expect(msgTextMatches(msg(""), "请在180秒内")).toBe(false);
    expect(msgTextMatches(null, "请在180秒内")).toBe(false);
    expect(msgTextMatches(null, undefined)).toBe(true);
  });
});
