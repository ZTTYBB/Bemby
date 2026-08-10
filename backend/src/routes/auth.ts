import { Router } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { db } from '../db/database';
import { bumpTokenEpoch, getJwtSecret, requireAuth, sessionClaims } from '../middleware/auth';
import {
  legacyHashPassword,
  hashPassword,
  isArgon2Hash,
  verifyPassword,
  timingSafeCompare as credTimingSafeCompare,
  constantTimeStringEquals,
  getStoredCredentials as getStoredCreds,
} from '../auth/credentials';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

// Both of these check the current password, so they are password guessing by another name
// and belong behind the same kind of brake as the login form.
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

const router = Router();

// Hash at module load so the env var is never compared as plaintext during a request
const ADMIN_PASSWORD_HASH_FALLBACK: string | null = (() => {
  const p = process.env.ADMIN_PASSWORD;
  return p ? legacyHashPassword(p) : null;
})();

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body as {
    username?: string;
    password?: string;
  };

  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  const stored = getStoredCreds();
  let valid: boolean;

  // The username is compared without short-circuiting and the password is always hashed,
  // so a wrong username costs the same as a wrong password and neither can be told apart
  // from the outside.
  const usernameOk = constantTimeStringEquals(username, stored.username);

  if (stored.passwordHash) {
    valid = (await verifyPassword(password, stored.passwordHash)) && usernameOk;
  } else {
    if (!ADMIN_PASSWORD_HASH_FALLBACK) {
      res.status(500).json({ error: 'ADMIN_PASSWORD env var is not set' });
      return;
    }
    valid = credTimingSafeCompare(legacyHashPassword(password), ADMIN_PASSWORD_HASH_FALLBACK) && usernameOk;
  }

  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  // Silently upgrade legacy HMAC hash to argon2id on next successful login
  if (stored.passwordHash && !isArgon2Hash(stored.passwordHash)) {
    const upgraded = await hashPassword(password);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password_hash', ?)").run(upgraded);
  }

  const defaultPwd = process.env.ADMIN_DEFAULT_PASSWORD ?? 'changeme';
  const requirePasswordChange = password === defaultPwd;
  const token = jwt.sign(sessionClaims(username, requirePasswordChange), getJwtSecret(), {
    expiresIn: '7d',
  });
  res.json(requirePasswordChange ? { token, requirePasswordChange: true } : { token });
});

// POST /revoke-sessions -- sign out everywhere. A token cannot be withdrawn once signed, so
// this moves the epoch every token is checked against, retiring the lot; the caller is then
// handed a new one so the tab it was invoked from stays logged in.
router.post('/revoke-sessions', requireAuth, (_req, res) => {
  bumpTokenEpoch();
  const { username } = getStoredCreds();
  res.json({
    message: 'All other sessions signed out',
    token: jwt.sign(sessionClaims(username), getJwtSecret(), { expiresIn: '7d' }),
  });
});

router.put('/credentials', requireAuth, credentialLimiter, async (req, res) => {
  const { username, currentPassword, newPassword } = req.body as {
    username?: string;
    currentPassword?: string;
    newPassword?: string;
  };

  if (!currentPassword) {
    res.status(400).json({ error: 'Current password is required' });
    return;
  }

  const stored = getStoredCreds();
  const validCurrent = stored.passwordHash
    ? await verifyPassword(currentPassword, stored.passwordHash)
    : ADMIN_PASSWORD_HASH_FALLBACK
      ? credTimingSafeCompare(legacyHashPassword(currentPassword), ADMIN_PASSWORD_HASH_FALLBACK)
      : false;

  if (!validCurrent) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }

  if (!username && !newPassword) {
    res.status(400).json({ error: 'Provide a new username or password' });
    return;
  }

  const newHash = newPassword ? await hashPassword(newPassword) : null;
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(() => {
    if (username) stmt.run('admin_username', username);
    if (newHash) stmt.run('admin_password_hash', newHash);
  })();

  // Changing the credentials has to mean something to a token already out there, or a
  // stolen one survives the change for the rest of its seven days. Moving the epoch first
  // retires every existing token; the fresh one below is signed under the new epoch, which
  // also clears any requirePasswordChange claim.
  bumpTokenEpoch();
  const newUsername = username || stored.username;
  const freshToken = jwt.sign(sessionClaims(newUsername), getJwtSecret(), { expiresIn: '7d' });
  res.json({ message: 'Credentials updated', token: freshToken });
});

export default router;