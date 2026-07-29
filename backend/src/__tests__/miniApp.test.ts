import { describe, it, expect } from 'vitest';
import { Api } from 'telegram';
import { webButtonOf } from '../tg/miniApp';
import { solveArithmetic } from '../jobs/cloudflare';

describe('webButtonOf', () => {
  it('reads a plain URL button', () => {
    const btn = new Api.KeyboardButtonUrl({ text: '我不是机器人', url: 'https://example.com/v' });
    expect(webButtonOf(btn)).toEqual({ text: '我不是机器人', url: 'https://example.com/v', miniApp: false });
  });

  it('flags a Mini App (WebView) button', () => {
    const btn = new Api.KeyboardButtonWebView({ text: '📱 打开小程序签到', url: 'https://eoos.top/telegram-miniapp' });
    expect(webButtonOf(btn)).toEqual({
      text: '📱 打开小程序签到',
      url: 'https://eoos.top/telegram-miniapp',
      miniApp: true,
    });
  });

  it('flags a simple WebView button', () => {
    const btn = new Api.KeyboardButtonSimpleWebView({ text: 'Verify', url: 'https://example.com/app' });
    expect(webButtonOf(btn)?.miniApp).toBe(true);
  });

  it('ignores callback buttons', () => {
    const btn = new Api.KeyboardButtonCallback({ text: '签到', data: Buffer.from('x') });
    expect(webButtonOf(btn)).toBeUndefined();
  });
});

describe('solveArithmetic', () => {
  it('solves the captcha forms mini apps use', () => {
    expect(solveArithmetic('签到验证\n5 + 3 = ?')).toBe('8');
    expect(solveArithmetic('8 + 2 = ?')).toBe('10');
    expect(solveArithmetic('9 - 4 = ？')).toBe('5');
    expect(solveArithmetic('6 × 7 =?')).toBe('42');
  });

  it('ignores numbers that are not a posed question', () => {
    expect(solveArithmetic('2026/08/10 到期')).toBeUndefined();
    expect(solveArithmetic('当前积分 43')).toBeUndefined();
  });
});
