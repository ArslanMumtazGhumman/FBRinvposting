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

### Step 3: REST endpoints
- **"Drafts only" means `draft`, `validated` and `failed`.** None of these reached FBR (a `failed` invoice
  was rejected, so FBR didn't record it), and the web app already edits and deletes them. `queued`,
  `posting`, `posted` and `outcome_unknown` are refused with 409 and a reason. The status check is in
  the UPDATE/DELETE's WHERE clause, so it can't race the posting worker.
- **Full replace, no field-level PATCH.** `PUT /invoices/:id` replaces the header and lines; the client always
  has the whole invoice. `status` from the client is limited to `draft`/`validated`; FBR fields, attempts
  and history are server-owned.
- **Customers and products: `PUT /:id` creates or replaces,** because the web app generates ids
  (`uid('c_')`); `POST /` exists for server-generated ids. An id that belongs to another business is a 409.
- **Bulk create is part of step 3** (`POST /invoices/bulk`, ≤500, 20 MB body limit on that route only),
  because step 5 needs it. Rows are validated one by one; valid rows are inserted in one transaction and
  bad or duplicate ones come back by index.
- **Invoice numbers.** If `localRef` is missing, the server reserves the next number(s) from
  `businesses.next_invoice_no` in the same transaction (`PREFIX` + 5 digits, as the web app formats them).
  Numbers reserved for rows that then turn out to be duplicates are skipped, not reused.
- **Cursor pagination on (created_at, id), newest first.** The cursor carries `created_at` as Postgres
  text so microseconds survive the round trip. Lines are loaded for the page in a single query.
- **Search (`q`)** is a case-insensitive substring match on invoice number, IRN and buyer name/NTN, with
  `%`/`_` escaped. No full-text index yet; add a trigram index when a business passes ~100k invoices.
- **Debit notes:** the schema and the database require `invoiceRefNo`; the API doesn't check that the IRN
  belongs to one of this business's posted invoices, because the original may have been posted outside Rasid.
- **Validation is shape and bounds only** (types, lengths, enums, real dates, NTN/CNIC digits). Tax rules stay
  in the web app's `tax.ts` and with FBR, because drafts may be incomplete.
- **Existing routes are validated too:** login, token save, FBR validate/post/reg-type. FBR payloads are
  checked against the exact v1.12 field set; unknown fields are dropped before the payload reaches FBR.
- **`src/app.ts` builds the app; `src/server.ts` listens.** Tests mount the real app on an ephemeral port.
