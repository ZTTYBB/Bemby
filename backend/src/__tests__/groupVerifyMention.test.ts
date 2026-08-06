// Which in-group verification prompt belongs to this account. A group taking a rush of
// joiners posts one prompt per person, and clicking a stranger's does nothing for us -- so
// the match has to cover every way a prompt names someone, including the account with no
// username at all (a text mention, which carries the user in an entity, not in the text).
vi.mock("../db/database", () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}));

import { describe, it, expect, vi } from "vitest";
import { messageAddressesUser } from "../jobs/custom";
import type { Api } from "telegram";

const me = { id: "778899123", username: "my_account" };
const noUsername = { id: "778899123" };

const msg = (text: string, extra: Record<string, unknown> = {}) =>
  ({ message: text, ...extra }) as unknown as Api.Message;

describe("messageAddressesUser", () => {
  it("takes the prompt naming us by username and leaves someone else's alone", () => {
    expect(messageAddressesUser(msg("@my_account 请在60秒内点击下方按钮完成验证"), me)).toBe(true);
    expect(messageAddressesUser(msg("@someone_else 请在60秒内点击下方按钮完成验证"), me)).toBe(false);
  });

  it("is not fooled by a username that merely starts with ours", () => {
    expect(messageAddressesUser(msg("@my_account2 请验证"), me)).toBe(false);
  });

  it("matches case-insensitively, since bots echo usernames as typed", () => {
    expect(messageAddressesUser(msg("@My_Account please verify"), me)).toBe(true);
  });

  it("honours the mentioned flag the server stamps on prompts aimed at us", () => {
    expect(messageAddressesUser(msg("新成员请验证", { mentioned: true }), me)).toBe(true);
  });

  it("finds an account with no username through the text mention entity", () => {
    const textMention = msg("新成员 请点击验证", {
      entities: [{ className: "MessageEntityMentionName", userId: BigInt("778899123") }],
    });
    expect(messageAddressesUser(textMention, noUsername)).toBe(true);
    const othersMention = msg("新成员 请点击验证", {
      entities: [{ className: "MessageEntityMentionName", userId: BigInt("111222333") }],
    });
    expect(messageAddressesUser(othersMention, noUsername)).toBe(false);
  });

  it("accepts a tg://user link and a bare numeric id", () => {
    expect(messageAddressesUser(msg("请 tg://user?id=778899123 点击验证"), noUsername)).toBe(true);
    expect(messageAddressesUser(msg("用户 778899123 请点击验证"), noUsername)).toBe(true);
    expect(messageAddressesUser(msg("id: 778899123"), noUsername)).toBe(true);
  });

  it("does not read our id out of a longer number", () => {
    expect(messageAddressesUser(msg("用户 7788991234 请点击验证"), noUsername)).toBe(false);
    expect(messageAddressesUser(msg("请在 180 秒内点击"), noUsername)).toBe(false);
  });

  it("rejects a prompt that names nobody, and a missing message", () => {
    expect(messageAddressesUser(msg("请点击下方按钮完成验证"), me)).toBe(false);
    expect(messageAddressesUser(null, me)).toBe(false);
  });
});
