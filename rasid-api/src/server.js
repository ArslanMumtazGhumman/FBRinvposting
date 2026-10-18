import cookieParser from 'cookie-parser';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { config } from './config.js';
import { authRoutes } from './routes/auth.js';
import { businessRoutes } from './routes/businesses.js';
import { credentialRoutes } from './routes/credentials.js';
import { fbrRoutes } from './routes/fbr.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind the CDN / load balancer

app.use(helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
}));

// CORS allow-list (credentials allowed only for listed origins).
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && config.corsOrigins.includes(origin)) {
    res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin',
      'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token, Idempotency-Key', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE' });
  }
  if (req.method === 'OPTIONS') return res.status(origin && config.corsOrigins.includes(origin) ? 204 : 403).end();
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/businesses', businessRoutes);
app.use('/api/businesses/:businessId/credentials', credentialRoutes);
app.use('/api/fbr/:businessId', fbrRoutes);

app.use((_req, res) => res.status(404).json({ message: 'Not found' }));
// Never leak stack traces; log a redacted line.
app.use((err, req, res, _next) => {
  console.error(JSON.stringify({ at: new Date().toISOString(), path: req.path, error: String(err.message).replace(/Bearer\s+\S+/g, 'Bearer [redacted]') }));
  res.status(err.status === 400 ? 400 : 500).json({ message: err.status === 400 ? 'Malformed request' : 'Something went wrong. Try again.' });
});

app.listen(config.port, () => console.log(`rasid-api listening on :${config.port}`));
