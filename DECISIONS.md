# Decisions

Choices made where the brief left room. Simpler option first; revisit if it hurts.

## Milestone 1

### Step 1: TypeScript
- **ESM with `.js` import specifiers** (`module: NodeNext`). Keeps the existing layout and lets `tsc` emit
  runnable ESM without a bundler or path rewriting.
- **Tests stay on `node:test`, run through `tsx --test`.** No new framework for the API; Vitest is only
  added in rasid-web (step 7).
- **`strict` + `noUncheckedIndexedAccess`.** FBR responses stay typed as `any` (`FbrJson`) because PRAL's
  shapes vary by endpoint; the route code only reads a few known fields.
- **Seeding runs from source in dev** (`npx tsx --env-file=.env src/seed.ts` / `npm run seed`) and from
  `dist/seed.js` in the image.
- **Reference-list lookup uses `Object.hasOwn`.** The JS version used truthiness on `PATHS[kind]`, which
  let prototype keys like `toString` through. That's the only behaviour change in this step.

### Step 2: PostgreSQL + Drizzle
- **Text primary keys** (`u_…`, `b_…`, `i_…`). The web app already makes string ids client-side and the
  API used prefixed UUIDs, so no id translation is needed in step 5.
- **Two database roles.** `MIGRATION_DATABASE_URL` owns the tables (migrations, seed). `DATABASE_URL` is
  a login role in the `rasid_app` group, which owns nothing, so RLS always applies to it. `db:migrate`
  creates that role on first run. The API refuses to start if its role is a superuser, has BYPASSRLS
  or owns `invoices`.
- **RLS context = user + business.** `withBusiness(userId, businessId, fn)` runs `fn` in a transaction
  after `set_config('app.user_id'/'app.business_id', …, true)` (the parameterisable form of `SET LOCAL`).
  Policies require `business_id = app.business_id` *and* that `app.user_id` is a member of it, so a
  route that forgets `requireBusiness` still can't read another tenant's rows. It's explicit per handler
  rather than one transaction per request, so no transaction stays open across a 30 s FBR call.
- **Tables without RLS:** `tenants` (read-only for the API) and `users` (login has to look a user up by
  email before there is any context; the API may only update `fails`, `locked_until`, `last_login_at`).
  `memberships` and `businesses` are filtered by `app.user_id` so the business list works without a
  business in context.
- **Roles come from the membership.** `requireRole` checks the role in the business (`memberships.role`)
  and falls back to `users.role` on routes that aren't business-scoped. The seed sets both to `owner`.
- **Idempotency moved into `api_calls`.** The JSON store's `postings` collection is gone; a successful
  post is the `api_calls` row with `outcome = 'ok'`, unique on (business, env, Idempotency-Key). The
  in-process `inflight` lock stays until step 4 replaces it.
- **Audit chain.** It's still SHA-256 over the previous hash plus the entry, but the entry is serialised
  canonically (sorted keys, null fields dropped) so a row read back from Postgres hashes the same as
  when written. Appends take `pg_advisory_xact_lock`, so the chain stays linear across API and worker
  processes. The API role can append but can't read the log; it gets the previous hash from the
  `SECURITY DEFINER` function `audit_tip()`. `verifyChain` needs the owner connection.
- **Append-only, enforced twice:** the API role has no UPDATE/DELETE grant on `api_calls`/`audit_log`,
  and triggers reject UPDATE, DELETE and TRUNCATE for every role, the owner included.
- **Posted invoices are immutable in the database.** Triggers reject UPDATE/DELETE of a `posted` invoice
  and any change to its lines. A CHECK makes a Debit Note carry `invoice_ref_no` (the original IRN).
  `invoice_items` has a composite FK to `invoices(id, business_id)`, because FK checks bypass RLS.
- **New invoice status `outcome_unknown`** for posts that timed out (used from step 4); the web model
  gets it in step 5.
- **No import from the old JSON files.** The JSON store was dev/pilot only. If a pilot has data in it,
  re-run the seed and re-save the FBR tokens in Settings.
- **Tests start Postgres 16 with Testcontainers** from this step on, because audit and RLS can't be tested
  without a database. CI's ubuntu runners have Docker.
- **docker-compose isn't updated until step 6**, so between steps 2 and 6 `docker compose up` needs an
  external Postgres in `DATABASE_URL`.
