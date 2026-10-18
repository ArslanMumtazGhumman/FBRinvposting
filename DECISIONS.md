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

### Step 4: Posting queue (BullMQ on Redis)
- **BullMQ 5.81 and ioredis 5.11, not BullMQ 6.** 6.3.16 was published the day before this step, and 6.x
  changes how connections are configured. 5.81.5 has been out for over a month.
- **The database status is the lock, not BullMQ job ids.** Queuing moves an invoice to `queued` with
  `UPDATE … WHERE status IN (draft, validated, failed)`. Only the rows that moved get jobs, so double clicks
  and two tabs can't queue an invoice twice. Jobs use BullMQ's own ids. If Redis refuses the jobs, those
  invoices go back to `failed` with "post again" and the request returns 503.
- **Before calling FBR the worker commits `posting`.** A job that finds its invoice already in `posting`
  (the worker crashed, the job stalled, or the result write failed) marks it `outcome_unknown` and doesn't
  call FBR. BullMQ retries a job up to 3 times, but that is only safe for failures that happen before
  `posting`.
- **Retry rules are unchanged.** `fbr-client` still retries a post only on connection failure or 502/503/504.
  A timeout becomes `outcome_unknown` and the job completes, so BullMQ doesn't retry it. Other failures
  become `failed` (L-500, "post again later"). There are no extra delayed BullMQ retries; the browser's
  "5s, 30s, 2m…" schedule was a comment, not existing behaviour.
- **Posting an `outcome_unknown` invoice again needs `{ "confirmNotInIris": true }`** on
  `POST /invoices/:id/post`, after a person has checked IRIS. Batches skip these invoices.
- **The idempotency key is the invoice id** (it was the `Idempotency-Key` header, the web's `localRef`). It
  is stable, and the invoice can't change after posting. If api_calls already holds an `ok` row for the key,
  the worker marks the invoice posted from that row and doesn't post again.
- **3 per business uses a Redis lease semaphore** (`queue/slots.ts`): a sorted set per business scored by
  lease expiry, with Redis server time, shared by every worker process. BullMQ's per-group limits are a
  Pro feature. When a business is full, the job is moved back to delayed for 0.3–1 s
  (`moveToDelayed` + `DelayedError`, which doesn't count as an attempt), so other businesses' jobs keep
  flowing. Leases expire after 4 × FBR timeout + 60 s, so a crashed worker can't hold a slot forever.
  `POST_WORKER_CONCURRENCY` (default 12) is the per-process total.
- **The worker uses the API database role, acting as the user who queued the job.** No new role, and RLS
  still applies. If that user loses access before the job runs, the job does nothing and the invoice stays
  `queued`. That's rare; an owner can see it.
- **The worker builds the FBR payload** (`lib/fbr-payload.ts`, a copy of the web's `toPayload` and
  `issuesFromResponse`) from the stored invoice and the business, and checks it with the zod
  `FbrInvoicePayload`. The seller fields always come from the business, so the old seller-NTN check isn't
  needed. The web's tax rules (`validateInvoice`) aren't repeated on the server; the web runs them before
  queuing (step 5) and FBR is the authority. Issues carry no `hint`; the web adds hints from the code.
- **The synchronous `POST /api/fbr/:businessId/post` route is removed,** along with the in-process `inflight`
  set. `validate`, `reference` and `reg-type` stay synchronous because they have no side effects.
- **SSE progress reads Postgres, not Redis pub/sub.** Every `BATCH_POLL_MS` (default 1 s) the stream
  counts the batch's statuses and sends invoices whose `updated_at` changed, with a 10 s overlap plus dedupe
  so late commits aren't missed. This works with any number of API and worker processes, survives restarts
  (reconnecting replays the current state) and needs no Redis connection per browser. Cost: one indexed
  query per open stream per second (new index `invoices_business_batch_idx`). `GET /batches/:id` gives the
  same counts as JSON.
- **A batch is just a `batch_id` on the invoices.** Queuing an invoice again (for example after fixing a
  rejection) moves it to the new batch, so the old batch's totals shrink. There's no separate batches table.
- **Up to 5000 ids per batch request.** Bulk import sends invoices in chunks of 500, but posting a whole
  import in one batch keeps a single progress bar.
- **docker-compose still lacks redis and a worker service until step 6.** The image already contains
  `dist/worker.js`. The worker has no HTTP port, so its service must disable the image's healthcheck.
- **Until step 5 the production web build can't post.** `FbrGatewayService.post` still calls the removed
  route. The offline demo (`npm start`, mock FBR) is unaffected. Step 5 switches `PostingService` to the queue.
