/**
 * Authentication: scrypt password hashes, optional TOTP (RFC 6238),
 * session JWT in an httpOnly SameSite=strict cookie, CSRF double-submit
 * cookie, and account lockout after repeated failures.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { find, upsert } from './db.js';

const SESSION_HOURS = 12;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  const [, salt, hash] = stored.split('$');
  const test = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'base64'));
}

/* ---------- TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s) {
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b, 2)));
}
function hotp(key, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
export function verifyTotp(secretB32, code) {
  if (!/^\d{6}$/.test(code ?? '')) return false;
  const key = base32Decode(secretB32);
  const t = Math.floor(Date.now() / 30000);
  return [-1, 0, 1].some(w => crypto.timingSafeEqual(Buffer.from(hotp(key, t + w)), Buffer.from(code)));
}
export function newTotpSecret() {
  return [...crypto.randomBytes(20)].map(b => B32[b % 32]).join('');
}

/* ---------- login ---------- */
export class AuthError extends Error { constructor(code, message, status = 401) { super(message); this.code = code; this.status = status; } }

export function login(email, password, otp) {
  const user = find('users', u => u.email === String(email).toLowerCase());
  if (user?.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) throw new AuthError('LOCKED', 'Too many attempts. Try again in 15 minutes.', 429);
  // Always run scrypt so response time does not reveal whether the email exists.
  const ok = user ? verifyPassword(password, user.passwordHash) : (hashPassword(password), false);
  if (!ok) {
    if (user) {
      const fails = (user.fails ?? 0) + 1;
      upsert('users', u => u.id === user.id, { ...user, fails, lockedUntil: fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null });
    }
    throw new AuthError('BAD_CREDENTIALS', 'Email or password is incorrect.');
  }
  if (user.totpSecret) {
    if (!otp) throw new AuthError('OTP_REQUIRED', 'Enter your authenticator code.');
    if (!verifyTotp(user.totpSecret, otp)) throw new AuthError('BAD_OTP', 'That code is not valid.');
  }
  upsert('users', u => u.id === user.id, { ...user, fails: 0, lockedUntil: null, lastLoginAt: new Date().toISOString() });
  return user;
}

export function issueSession(res, user) {
  const token = jwt.sign({ sub: user.id, role: user.role }, config.sessionSecret, { expiresIn: `${SESSION_HOURS}h`, algorithm: 'HS256' });
  const secure = config.env === 'production';
  res.cookie('rasid_session', token, { httpOnly: true, secure, sameSite: 'strict', maxAge: SESSION_HOURS * 3600e3, path: '/api' });
  res.cookie('rasid_csrf', crypto.randomBytes(24).toString('base64url'), { httpOnly: false, secure, sameSite: 'strict', maxAge: SESSION_HOURS * 3600e3, path: '/' });
}

export function clearSession(res) {
  res.clearCookie('rasid_session', { path: '/api' });
  res.clearCookie('rasid_csrf', { path: '/' });
}

/** Express middleware: valid session + CSRF header on state-changing requests. */
export function requireAuth(req, res, next) {
  try {
    const claims = jwt.verify(req.cookies?.rasid_session ?? '', config.sessionSecret, { algorithms: ['HS256'] });
    const user = find('users', u => u.id === claims.sub);
    if (!user) throw new Error('no user');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const header = req.get('X-CSRF-Token') ?? '';
      const cookie = req.cookies?.rasid_csrf ?? '';
      if (!header || header.length !== cookie.length || !crypto.timingSafeEqual(Buffer.from(header), Buffer.from(cookie))) {
        return res.status(403).json({ code: 'CSRF', message: 'Security check failed. Reload the page.' });
      }
    }
    req.user = user;
    next();
  } catch {
    res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Sign in again.' });
  }
}

export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ code: 'FORBIDDEN', message: 'Your role cannot do this.' });

/** Membership check: the user must belong to the business in :businessId. */
export function requireBusiness(req, res, next) {
  const m = find('memberships', x => x.userId === req.user.id && x.businessId === req.params.businessId);
  if (!m) return res.status(404).json({ code: 'NOT_FOUND', message: 'Business not found.' });
  req.membership = m;
  next();
}
