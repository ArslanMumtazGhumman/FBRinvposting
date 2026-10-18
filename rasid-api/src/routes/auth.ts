import { Router } from 'express';
import { AuthError, clearSession, issueSession, login, requireAuth } from '../lib/auth.js';
import { audit } from '../lib/audit.js';

export const authRoutes = Router();

authRoutes.post('/login', (req, res) => {
  try {
    const user = login(req.body?.email ?? '', req.body?.password ?? '', req.body?.otp);
    issueSession(res, user);
    audit({ actor: user.id, action: 'login', ip: req.ip });
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
  } catch (e) {
    if (e instanceof AuthError) {
      audit({ actor: String(req.body?.email ?? '').toLowerCase(), action: 'login_failed', detail: e.code, ip: req.ip });
      return res.status(e.status).json({ code: e.code, message: e.message });
    }
    throw e;
  }
});

authRoutes.post('/logout', requireAuth, (req, res) => {
  audit({ actor: req.user.id, action: 'logout', ip: req.ip });
  clearSession(res);
  res.status(204).end();
});

authRoutes.get('/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({ id: u.id, name: u.name, email: u.email, role: u.role });
});
