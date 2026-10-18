# Rasid — FBR Digital Invoicing

Post sales-tax invoices to FBR's Digital Invoicing API (PRAL spec v1.12) from a form or from any Excel/CSV layout.

```
rasid/
├── rasid-web/   Angular 21 app (standalone components, signals, zoneless, CDK virtual scroll, SheetJS in a Web Worker)
├── rasid-api/   Node 22 + TypeScript API: sessions + 2FA, AES-256-GCM token vault, FBR gateway with retry/idempotency, audit chain
├── docker-compose.yml
└── .github/workflows/ci.yml
```

## Try it in 2 minutes (no FBR token, no backend)

```bash
cd rasid-web
npm install          # .npmrc sets legacy-peer-deps
npm start            # http://localhost:4200
```

The development build runs an in-browser FBR simulator: real PRAL-shaped responses, error codes
(0019, 0046, 0096, 0102, 0104 …), IRN generation, and ~4% random HTTP 500s so you can watch retries.
Sign in with any email and an 8+ character password. Sample business, customers, products and
42 invoices are pre-loaded. On **Bulk import**, click **Try with sample data** to load a messy sheet
(different headers, DD/MM/YYYY dates, three deliberate mistakes).

## Run the full stack

```bash
cd rasid-api
cp .env.example .env     # fill VAULT_KEY_V1 and SESSION_SECRET (commands are in the file)
npm install
npx tsx --env-file=.env src/seed.ts owner@company.pk "Owner Name" "a-strong-password" 1234567 "Company (Pvt) Ltd"
#   → prints a TOTP secret: add it to Google Authenticator / Authy
cd .. && docker compose up --build      # web + api on http://localhost:8080
```

Production builds (`ng build`) use `environment.ts`: `mockFbr: false`, API at same-origin `/api`.
Then in the app: Settings → FBR connection → paste the sandbox token from IRIS → Sandbox scenarios → Run all.

## API development

```bash
cd rasid-api
npm run dev         # tsx watch, no build step
npm run typecheck   # tsc --noEmit
npm test            # node:test via tsx
npm run build       # tsc -> dist/ (what the Docker image runs)
```

## What is where

| Feature | Code |
| --- | --- |
| FBR payload types (exact v1.12 field names) | `rasid-web/src/app/core/models.ts` |
| Tax calculation, client-side FBR rule checks, payload builder | `rasid-web/src/app/core/tax.ts` |
| Reference data, sale types, 28 scenarios, activity×sector matrix, error help | `rasid-web/src/app/core/fbr-reference.ts` |
| Smart column matching (synonyms + content sniffing), date/UOM/province normalising, row grouping | `rasid-web/src/app/core/import/smart-mapper.ts` |
| Excel parsing off the main thread | `rasid-web/src/app/core/import/excel.worker.ts` |
| Validate → post orchestration, bounded-concurrency queue, retries | `rasid-web/src/app/core/posting.service.ts` |
| FBR simulator / HTTP gateway switch | `rasid-web/src/app/core/fbr-gateway.service.ts` |
| Token vault (AES-256-GCM, key versions, AAD = business) | `rasid-api/src/lib/vault.ts` |
| Login, scrypt, TOTP, lockout, cookie session, CSRF | `rasid-api/src/lib/auth.ts` |
| PRAL client (sandbox `_sb` routing, timeouts, safe retry) | `rasid-api/src/lib/fbr-client.ts` |
| Idempotent posting, reference cache, seller-NTN guard | `rasid-api/src/routes/fbr.ts` |
| Hash-chained audit log | `rasid-api/src/lib/audit.ts` |

## Before going live

- **Storage:** `rasid-api/src/lib/db.ts` is a JSON-file store for development and a single-node pilot.
  Replace it with PostgreSQL (schema in the product plan) with row-level security on `business_id`,
  and move posting into BullMQ workers on Redis. Route handlers only use its five functions.
- **Invoices:** the web app keeps invoices in the browser (localStorage) in this version. Add
  `/api/invoices` CRUD backed by Postgres before onboarding real customers, so records survive device
  changes and are covered by backups.
- **Keys:** load `VAULT_KEY_*` from KMS/Vault, not a file. Rotate by adding `VAULT_KEY_V2` and
  switching `VAULT_ACTIVE_KEY`.
- **FBR logo:** the invoice print view has a placeholder box. Use the official Digital Invoicing System
  image supplied by PRAL (spec section 6). QR is version 2 at 1 × 1 inch, as specified.
- **Rates:** default rates per sale type in `fbr-reference.ts` are illustrative. Load live rates from
  `/pdi/v2/SaleTypeToRate` and confirm the further-tax rate with a tax adviser.
- **Timeouts on post:** FBR offers no idempotency or lookup, so a post that times out is reported as
  "outcome unknown" (never auto-retried) and the user is told to check IRIS first.
- **Angular 22:** this project targets Angular 21 because 22 needs Node ≥ 22.22.3. Run
  `npx ng update @angular/core@22 @angular/cli@22` once your Node is new enough.
- Pen test, OWASP ASVS L2 review, and a legal opinion on operating with customers' PRAL tokens.

## Keyboard

`Alt+N` new invoice · `Alt+I` bulk import · `Ctrl+S` save draft · `Ctrl+Enter` post to FBR · Enter in the
last unit-price cell adds a line.
