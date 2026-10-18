# Rasid — FBR Digital Invoicing

Post sales-tax invoices to FBR's Digital Invoicing API (PRAL spec v1.12) from a form or from any Excel/CSV layout.

```
rasid/
├── rasid-web/   Angular 21 app (standalone components, signals, zoneless, CDK virtual scroll, SheetJS in a Web Worker)
├── rasid-api/   Node 22 + TypeScript API (PostgreSQL 16 + Drizzle, row-level security, BullMQ posting worker on Redis): sessions + 2FA, AES-256-GCM token vault, audit chain
├── docker-compose.yml
└── .github/workflows/ci.yml
```

## Try it in 2 minutes (no FBR token, no backend)

```bash
cd rasid-web
npm install          # .npmrc sets legacy-peer-deps
npm start            # http://localhost:4200
```

The development build (`useApi: false` in `environment.development.ts`) keeps all data in the browser's
localStorage and runs an in-browser FBR simulator: real PRAL-shaped responses, error codes
(0019, 0046, 0096, 0102, 0104 …), IRN generation, and ~4% random HTTP 500s so you can watch retries.
Sign in with any email and an 8+ character password. Sample business, customers, products and
42 invoices are pre-loaded. On **Bulk import**, click **Try with sample data** to load a messy sheet
(different headers, DD/MM/YYYY dates, three deliberate mistakes).

## Run the full stack

```bash
cp .env.example .env            # fill the three passwords, VAULT_KEY_V1 and SESSION_SECRET (see the file)
docker compose up -d --build    # postgres, redis → migrate (one-off) → api, worker → web on http://localhost:8080
docker compose run --rm migrate node dist/seed.js owner@company.pk "Owner Name" "a-strong-password" 1234567 "Company (Pvt) Ltd"
#   → prints a TOTP secret: add it to Google Authenticator / Authy
docker compose run --rm migrate node dist/reference-cli.js set-token
#   → paste Rasid's own PRAL token (input hidden): the worker caches FBR's reference lists with it, nightly
```

| Service | What it does |
| --- | --- |
| `postgres` | PostgreSQL 16, volume `pg-data`. Not published to the host. |
| `redis` | Redis 7 for the posting queue: password, append-only file, `noeviction`, volume `redis-data`. Not published. |
| `migrate` | Runs once per `up`: applies migrations as the table owner and creates the API login role. Also runs `seed`. |
| `api` | The API, as the RLS-bound login role. Never sees the table owner's password. |
| `worker` | Same image, `node dist/worker.js`: posts queued invoices to FBR and refreshes PRAL reference lists nightly. `docker compose up -d --scale worker=2` adds more; still 3 per business in total, one refresh per night. |
| `web` | nginx: the Angular build plus `/api` proxy (20 MB body limit on bulk import only, unbuffered SSE). |

Upgrading: `docker compose up -d --build` rebuilds, runs `migrate`, then restarts `api` and `worker`. Stopping the worker
lets in-flight posts finish (2 minutes' grace); if it is killed, the posts it had in flight become "Check IRIS".

To run the API outside Docker, use `rasid-api/.env.example` and `npm run db:migrate`, `npm run dev`, `npm run dev:worker`.

Production builds (`ng build`) use `environment.ts`: `useApi: true`, API at same-origin `/api`. All data then lives
in Postgres and posting runs on the server queue. To develop the web app against a local API, set
`useApi: true` in `environment.development.ts` (API on `http://localhost:3000/api`, `CORS_ORIGINS=http://localhost:4200`).
Then in the app: Settings → FBR connection → paste the sandbox token from IRIS → Sandbox scenarios → Run all.

## Tests

| Where | Command | What |
| --- | --- | --- |
| `rasid-web` | `npx ng test --watch=false` | Vitest: `tax.ts` (rates, line maths, FBR rule checks, payload), `smart-mapper.ts` on the sample sheet (header matching, DD/MM/YYYY dates, NTN cleanup, row grouping), `ApiStoreService`, `PostingService`, `ReferenceService` |
| `rasid-api` | `npm test` | node:test against Postgres 16 and Redis 7 in Testcontainers (needs Docker): RLS and audit chain, every endpoint, the posting queue, the reference cache against a fake PRAL (`reference.test.ts`), and `security.test.ts` (no endpoint returns a token, tenant isolation on every route, idempotent posting) |

## API development

```bash
cd rasid-api
npm run dev         # API: tsx watch, no build step
npm run dev:worker  # posting worker (needs Redis): tsx watch
npm run typecheck   # tsc --noEmit
npm test            # node:test via tsx; starts Postgres 16 and Redis 7 with Testcontainers (needs Docker)
npm run db:generate # after editing src/db/schema.ts: writes a new drizzle/ migration
npm run build       # tsc -> dist/ (what the Docker image runs)
```

## API

All business routes are under `/api/businesses/:businessId`, need a session, and need the `X-CSRF-Token`
header on writes. Every body is validated with zod (`rasid-api/src/schemas`); a 400 lists
`issues: [{ path, message }]`. Viewers can read; owners and accountants can write.

| Route | Notes |
| --- | --- |
| `GET /invoices` | `?status=draft,validated&environment&invoiceType&from&to&batchId&q&limit≤200&cursor` → `{ items, nextCursor }`, newest first |
| `GET /invoices/:id` | Same shape as `Invoice` in `models.ts` |
| `POST /invoices` | Allocates the next invoice number unless `localRef` is given; 409 on duplicates |
| `POST /invoices/bulk` | Up to 500 invoices; returns `{ created: [{ index, invoice }], errors: [{ index, issues }] }` |
| `PUT /invoices/:id` | Full replace; only `draft`, `validated`, `failed` (409 otherwise) |
| `DELETE /invoices/:id` | Same states; posted invoices are corrected with a Debit Note referencing the IRN |
| `GET/POST /customers`, `GET/PUT/DELETE /customers/:id` | `PUT` creates or replaces (the web app makes ids) |
| `GET/POST /products`, `GET/PUT/DELETE /products/:id` | as customers |
| `GET/POST /import-mappings`, `DELETE /import-mappings/:id` | `POST` replaces the mapping with the same header signature |
| `POST /invoices/:id/post` | Queues one invoice for FBR → 202 `{ batchId, invoice }`. 409 if already queued/posted. An `outcome_unknown` invoice needs `{ "confirmNotInIris": true }` |
| `POST /invoices/post-batch` | `{ ids }` (≤5000) → 202 `{ batchId, queued, skipped: [{ id, status, message }] }` |
| `GET /invoices/batches/:batchId` | Progress: `{ total, queued, posting, posted, failed, outcomeUnknown, done, running }` |
| `GET /invoices/batches/:batchId/events` | Same progress as Server-Sent Events: `progress`, `invoice` (status, IRN, issues), then `done` |
| `PUT /credentials/:env`, `POST /credentials/:env/test` | Tokens are write-only |
| `POST /api/businesses`, `PUT /api/businesses/:businessId` | Add a business (tenant owners; you become its owner) / update profile and defaults (business owners) |

FBR checks stay synchronous under `/api/fbr/:businessId`: `POST /validate`, `POST /reg-type`. Posting
happens only in the worker (`node dist/worker.js`): at most 3 FBR calls in flight per business, a timed-out
post becomes `outcome_unknown` and is never retried automatically.

### Reference data

PRAL's reference lists are the same for every tenant, so they live under `/api/reference` (any signed-in
user, no business). They're served from Postgres, filled nightly by the worker with Rasid's own PRAL token
(`reference-cli set-token`), never a customer's. On a miss the API asks PRAL live (5 s, no retries) and caches
the answer. `source: "none"` means there's no PRAL copy yet, and the web app falls back to its bundled lists.

| Route | Notes |
| --- | --- |
| `GET /sale-types?province=Punjab&date=YYYY-MM-DD` | PRAL rates per Rasid sale type for the seller's province (`date` defaults to today in Pakistan) |
| `GET /hs-codes?q=sugar&limit=20` | HS search: code prefix (`1701`, `1701.99`, `170199`) or all words in the description |
| `GET /hs-codes/:code/uoms` | Units FBR accepts for an HS code (`HS_UOM`) |
| `GET /sro-schedules?rateId&province&date`, `GET /sro-items?sroId&date` | SRO schedules for a PRAL rate, items of a schedule |
| `GET /provinces`, `GET /uoms` | As PRAL lists them, with PRAL's codes |
| `GET /status` | Cache freshness per list, and whether the reference token is set (never the token) |

Operators: `node dist/reference-cli.js set-token | clear-token | refresh [YYYY-MM-DD] | status` (in compose:
`docker compose run --rm migrate node dist/reference-cli.js …`). The schedule is `REFERENCE_REFRESH_CRON`
(default `30 2 * * *`, Pakistan time).

## What is where

| Feature | Code |
| --- | --- |
| FBR payload types (exact v1.12 field names) | `rasid-web/src/app/core/models.ts` |
| Tax calculation, client-side FBR rule checks, payload builder | `rasid-web/src/app/core/tax.ts` |
| Sale types, 28 scenarios, activity×sector matrix, error help; offline fallback lists | `rasid-web/src/app/core/fbr-reference.ts` |
| Live PRAL rates, units, HS search, HS→UOM, SRO suggestions in the forms | `rasid-web/src/app/core/reference.service.ts` |
| Smart column matching (synonyms + content sniffing), date/UOM/province normalising, row grouping | `rasid-web/src/app/core/import/smart-mapper.ts` |
| Excel parsing off the main thread | `rasid-web/src/app/core/import/excel.worker.ts` |
| Client state: one `Store` contract, offline (`StoreService`, localStorage) or API-backed (`ApiStoreService`) | `rasid-web/src/app/core/store.ts`, `store.service.ts`, `api-store.service.ts` |
| Validate → post orchestration (offline: in-browser queue; API: server queue + SSE) | `rasid-web/src/app/core/posting.service.ts` |
| FBR simulator / HTTP gateway switch | `rasid-web/src/app/core/fbr-gateway.service.ts` |
| Token vault (AES-256-GCM, key versions, AAD = business) | `rasid-api/src/lib/vault.ts` |
| Login, scrypt, TOTP, lockout, cookie session, CSRF | `rasid-api/src/lib/auth.ts` |
| PRAL client (sandbox `_sb` routing, timeouts, safe retry) | `rasid-api/src/lib/fbr-client.ts` |
| FBR validate, buyer registration check, seller-NTN guard | `rasid-api/src/routes/fbr.ts` |
| PRAL reference cache: nightly refresh, lookups, HS search, Rasid's reference token | `rasid-api/src/reference/`, `rasid-api/src/queue/reference.ts`, `rasid-api/src/routes/reference.ts`, `rasid-api/src/reference-cli.ts` |
| Queue for posting, batch progress (SSE) | `rasid-api/src/routes/posting.ts`, `rasid-api/src/repos/posting.ts` |
| Posting worker (BullMQ): idempotency, outcome-unknown handling | `rasid-api/src/queue/worker.ts` |
| 3-per-business FBR concurrency across workers | `rasid-api/src/queue/slots.ts` |
| Server-side FBR payload builder (twin of `toPayload`) | `rasid-api/src/lib/fbr-payload.ts` |
| Request validation (zod) | `rasid-api/src/schemas/*.ts` |
| Hash-chained audit log | `rasid-api/src/lib/audit.ts` |
| Database schema | `rasid-api/src/db/schema.ts` |
| Row-level security, append-only and posted-invoice guards | `rasid-api/drizzle/0001_rls.sql` |
| Per-request business context (`withBusiness`) | `rasid-api/src/db/client.ts` |
| Invoice persistence (shared with the posting worker) | `rasid-api/src/repos/invoices.ts` |

## Before going live

- **Large businesses:** the web app caches the newest 5,000 invoices of the active business and filters
  them in the browser. Move the invoice list to server-side filtering and paging (the API already supports
  it) before a business passes that.
- **Backups:** back up the `pg-data` volume (or use a managed Postgres with point-in-time recovery). Redis holds only
  queue state; the invoices' status in Postgres is the record.
- **Keys:** load `VAULT_KEY_*` from KMS/Vault, not a file. Rotate by adding `VAULT_KEY_V2` and
  switching `VAULT_ACTIVE_KEY`.
- **FBR logo:** the invoice print view has a placeholder box. Use the official Digital Invoicing System
  image supplied by PRAL (spec section 6). QR is version 2 at 1 × 1 inch, as specified.
- **Rates:** set Rasid's reference token (`reference-cli set-token`) so rates, units and HS codes come from PRAL;
  without it the bundled, illustrative rates in `fbr-reference.ts` are shown. Run `reference-cli refresh` then
  `status` once with the real token: the PRAL response shapes are tested against a fake, not the live sandbox.
  Confirm the further-tax rate with a tax adviser.
- **Timeouts on post:** FBR offers no idempotency or lookup, so a post that times out is reported as
  "outcome unknown" (never auto-retried) and the user is told to check IRIS first.
- **Angular 22:** this project targets Angular 21 because 22 needs Node ≥ 22.22.3. Run
  `npx ng update @angular/core@22 @angular/cli@22` once your Node is new enough.
- Pen test, OWASP ASVS L2 review, and a legal opinion on operating with customers' PRAL tokens.

## Keyboard

`Alt+N` new invoice · `Alt+I` bulk import · `Ctrl+S` save draft · `Ctrl+Enter` post to FBR · Enter in the
last unit-price cell adds a line.
