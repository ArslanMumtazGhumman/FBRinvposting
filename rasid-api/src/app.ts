import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { config } from './config.js';
import { pgCode, PG } from './lib/http.js';
import { authRoutes } from './routes/auth.js';
import { businessRoutes } from './routes/businesses.js';
import { credentialRoutes } from './routes/credentials.js';
import { customerRoutes } from './routes/customers.js';
import { fbrRoutes } from './routes/fbr.js';
import { importMappingRoutes } from './routes/import-mappings.js';
import { invoiceRoutes } from './routes/invoices.js';
import { postingRoutes } from './routes/posting.js';
import { productRoutes } from './routes/products.js';

/** The Express app without a listener (server.ts listens; tests mount it on an ephemeral port). */
export function createApp() {
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

  // Bulk import sends up to 500 invoices per request; everything else stays at 1 MB.
  app.use('/api/businesses/:businessId/invoices/bulk', express.json({ limit: '20mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes);
  app.use('/api/businesses', businessRoutes);
  app.use('/api/businesses/:businessId/credentials', credentialRoutes);
  app.use('/api/businesses/:businessId/invoices', postingRoutes);
  app.use('/api/businesses/:businessId/invoices', invoiceRoutes);
  app.use('/api/businesses/:businessId/customers', customerRoutes);
  app.use('/api/businesses/:businessId/products', productRoutes);
  app.use('/api/businesses/:businessId/import-mappings', importMappingRoutes);
  app.use('/api/fbr/:businessId', fbrRoutes);

  app.use((_req: Request, res: Response) => res.status(404).json({ message: 'Not found' }));
  // Never leak stack traces or SQL; log a redacted line.
  app.use((err: Error & { status?: number }, req: Request, res: Response, _next: NextFunction) => {
    if (err.status === 400) return res.status(400).json({ message: 'Malformed request' });
    if (err.status === 413) return res.status(413).json({ message: 'Request is too large.' });
    if (pgCode(err) === PG.uniqueViolation) return res.status(409).json({ code: 'CONFLICT', message: 'That record already exists.' });
    console.error(JSON.stringify({ at: new Date().toISOString(), path: req.path, error: String(err.message).replace(/Bearer\s+\S+/g, 'Bearer [redacted]').slice(0, 300) }));
    res.status(500).json({ message: 'Something went wrong. Try again.' });
  });
  return app;
}
