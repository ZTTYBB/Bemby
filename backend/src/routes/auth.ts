import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import svgCaptcha from 'svg-captcha';
import { db } from '../db/database';
import { getJwtSecret, requireAuth } from '../middleware/auth';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

const router = Router();

type SettingRow = { key: string; value: string };

// Fixed key so stored hashes are not invalidated when JWT_SECRET rotates
const PWD_HMAC_KEY = 'bemby-pwd-v1';

function hashPassword(password: string): string {
  return crypto.createHmac('sha256', PWD_HMAC_KEY).update(password).digest('hex');
}

function getStoredCredentials(): { username: string; passwordHash: string | null } {
  const rows = db.prepare(
    "SELECT key, value FROM settings WHERE key IN ('admin_username', 'admin_password_hash')"
  ).all() as SettingRow[];
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    username: map['admin_username'] ?? (process.env.ADMIN_USERNAME ?? 'admin'),
    passwordHash: map['admin_password_hash'] ?? null,
  };
}

router.get('/captcha', (_req, res) => {
  const captcha = svgCaptcha.create({ noise: 2, color: true, size: 5, ignoreChars: '0oO1lI' });
  // Store the answer (lowercase) in a short-lived signed token — no session needed
  const captchaToken = jwt.sign({ cap: captcha.text.toLowerCase() }, getJwtSecret(), { expiresIn: '5m' });
  res.json({ svg: captcha.data, captchaToken });
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password, captchaToken, captchaAnswer } = req.body as {
    username?: string;
    password?: string;
    captchaToken?: string;
    captchaAnswer?: string;
  };

  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  if (!captchaToken || !captchaAnswer) {
    res.status(400).json({ error: 'Captcha is required' });
    return;
  }

  let captchaPayload: { cap?: string };
  try {
    captchaPayload = jwt.verify(captchaToken, getJwtSecret()) as { cap?: string };
  } catch {
    res.status(400).json({ error: 'Captcha expired, please refresh' });
    return;
  }

  if (captchaPayload.cap !== captchaAnswer.toLowerCase().trim()) {
    res.status(400).json({ error: 'Incorrect captcha' });
    return;
  }

  const stored = getStoredCredentials();
  let valid: boolean;

  if (stored.passwordHash) {
    valid = username === stored.username && hashPassword(password) === stored.passwordHash;
  } else {
    const envPass = process.env.ADMIN_PASSWORD ?? '';
    if (!envPass) {
      res.status(500).json({ error: 'ADMIN_PASSWORD env var is not set' });
      return;
    }
    valid = username === stored.username && password === envPass;
  }

  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = jwt.sign({ sub: username }, getJwtSecret(), { expiresIn: '7d' });
  res.json({ token });
});

router.put('/credentials', requireAuth, (req, res) => {
  const { username, currentPassword, newPassword } = req.body as {
    username?: string;
    currentPassword?: string;
    newPassword?: string;
  };

  if (!currentPassword) {
    res.status(400).json({ error: 'Current password is required' });
    return;
  }

  const stored = getStoredCredentials();
  const validCurrent = stored.passwordHash
    ? hashPassword(currentPassword) === stored.passwordHash
    : currentPassword === (process.env.ADMIN_PASSWORD ?? '');

  if (!validCurrent) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }

  if (!username && !newPassword) {
    res.status(400).json({ error: 'Provide a new username or password' });
    return;
  }

  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(() => {
    if (username) stmt.run('admin_username', username);
    if (newPassword) stmt.run('admin_password_hash', hashPassword(newPassword));
  })();

  res.json({ message: 'Credentials updated' });
});

export default router;
