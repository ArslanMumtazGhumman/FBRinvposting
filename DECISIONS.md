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

### Step 5: Frontend on the API
- **`Store` (abstract class) is the DI token; the two implementations sit behind it.** `StoreService`
  (offline, localStorage) and `ApiStoreService` (HttpClient) extend `Store`. The signals and computed
  selectors live in `Store`, so components see the same surface either way. `app.config.ts` picks the
  implementation from `environment.useApi`. Components now `inject(Store)`.
- **One flag, `useApi`, replaces `mockFbr`.** Two flags would allow combinations that make no sense
  (API data with a simulated FBR). `npm start` → `useApi: false` (offline demo); `ng build` → `useApi: true`.
  `PostingService` follows `store.mode` rather than reading the flag itself, so it can't disagree with the store.
- **Writes are async and optimistic.** Every write method returns a promise. The API store shows the
  change at once, sends it, replaces it with the server's copy, and puts the old value back if the API
  refuses; the promise then rejects with the API's message and the page shows it. Writes to one record
  are queued, so save-then-edit can't arrive out of order (a PUT before its POST).
  - `patchInvoice` stays synchronous and only updates the cache. With the API, posting results come from the server.
  - The client always sends `draft` or `validated`; it can't set `failed`, `posted` or history.
- **The API store caches the newest 5,000 invoices of the active business.** The list, dashboard and
  editor work on that cache, as they did with localStorage. Server-side list filtering is a follow-up (README).
- **Invoice numbers.** The editor still shows the next number as you type (`nextLocalRef` moves only
  the cached counter). On save, the server moves its own counter past any number in the business's
  `PREFIX + digits` format, so server-allocated numbers never collide with ones the browser showed.
  Two people creating at the same moment can still pick the same number; the second save gets a 409.
- **Business create/update endpoints** (`POST /api/businesses`, `PUT /api/businesses/:id`).
  - Creating goes through a `SECURITY DEFINER` function, `create_business(jsonb)`. It adds the business to the caller's tenant and makes them the owner, and only users whose tenant role is `owner` may call it. The API role still can't insert businesses or memberships directly.
  - Updating is for business owners. A change of environment is audited as `environment_production` / `environment_sandbox`.
- **Session restore.** In API mode nothing about the user is kept in localStorage. `authGuard` calls
  `GET /auth/me` once on a reload, and a 401 on any call signs the user out. Pages that look a record up by id
  (the editor) wait for `store.ready()`, so a reload on `/invoices/:id/edit` doesn't open a blank "new" invoice.
- **Bulk import.**
  - The Excel file is still parsed in the Web Worker. The built invoices are saved with `POST /invoices/bulk` in chunks of 500, with a saving progress bar.
  - Rows the server refuses are listed by invoice number and not posted.
  - The saved, valid ones are queued in one batch.
- **Posting with the API.**
  - `PostingService` queues (`/post` or `/post-batch`) and follows the batch over `EventSource` (SSE). It updates each invoice as `invoice` events arrive, then reloads the batch (`GET /invoices?batchId=`) so history and IRNs match the server exactly.
  - If the stream fails (proxy buffering, network drop), it closes it, to stop the browser auto-reconnecting, and polls `GET /batches/:id` every 2 s.
  - Pause/Resume/Stop are hidden in API mode: the server queue can't pause one batch.
- **Server issues carry no hint text;** the web app adds `FBR_ERROR_HELP[code]` when results arrive.
- **`outcome_unknown` in the UI.**
  - The chip reads "Check IRIS". Those invoices count with the rejected ones on the dashboard and in the list filter, and open read-only.
  - The detail page offers "Not in IRIS: post again". It asks for confirmation and sends `confirmNotInIris`.
- **Sandbox scenarios with the API** create a real test invoice and post it through the queue, because the
  synchronous post route is gone. The test invoices appear in the sandbox invoice list.
- **The worker now keeps FBR's response when the invoice update is refused.** The browser e2e run found it: a
  duplicate IRN from the fake FBR rolled back the api_calls row together with the invoice update. The
  update now runs in a savepoint. A duplicate IRN becomes `outcome_unknown` (`L-409`), and the api_calls row
  with FBR's answer is kept.
- **Web unit tests** (`ng test`, Vitest + HttpTestingController) cover `ApiStoreService` and the queue path
  of `PostingService`. Shared fixtures live in `src/testing/`, excluded from the app build. CI runs them.
  Vitest for `tax.ts` / `smart-mapper.ts` is step 7.

### Step 6: docker-compose
- **One `.env` at the repo root drives compose; `rasid-api/.env.example` stays for running the API outside
  Docker.** Compose builds the connection URLs from the passwords (`POSTGRES_PASSWORD`, `DB_APP_PASSWORD`,
  `REDIS_PASSWORD`), so they are written once. Passwords end up inside URLs, so `.env.example` asks for hex.
- **No `env_file` on the app containers.** Each service lists the variables it gets, so `api` and `worker` never
  receive the table owner's password or `MIGRATION_DATABASE_URL`; only `migrate` does. The catch: a new
  variable (for example `VAULT_KEY_V2` when rotating keys) must be added to `docker-compose.yml` too.
- **Migrations run as a one-off `migrate` service** (same image, `node dist/db/migrate.js`). `api` and
  `worker` wait for it to finish successfully (`service_completed_successfully`), so a failed migration
  stops the rollout instead of starting new code on an old schema. Seeding uses the same service:
  `docker compose run --rm migrate node dist/seed.js …`.
- **Redis:** password-protected, `appendonly yes`, `maxmemory-policy noeviction`, its own volume. Without
  persistence a restart would drop queued jobs (the invoices would stay `queued`); eviction could do the same.
- **Only `web` publishes a port.** Postgres, Redis and the API are reachable on the compose network only.
- **Worker:** same image with `node dist/worker.js`, the image's HTTP healthcheck disabled, and
  `stop_grace_period: 2m`, so a stop or upgrade lets in-flight posts record their result. The smoke test checks
  a graceful restart mid-batch (all 500 posted, none twice) and a SIGKILL mid-batch: the at most 3 interrupted
  posts become `outcome_unknown` after BullMQ's stalled-job check (~30 s), the rest post, and none is sent twice.
- **nginx changes that the new features need:** a 20 MB body limit on `/invoices/bulk` only (500 invoices
  with several lines each is ~2.5 MB, over the old 2 MB limit), and unbuffered, long-lived proxying for
  `/batches/:id/events` (SSE). The API also sends `X-Accel-Buffering: no`.
- **Two existing bugs, found when the stack first ran in compose, are fixed:**
  - The web image ran stock `nginx` as `USER nginx`, which can't create its cache directories, so the container
    crash-looped. It now uses `nginxinc/nginx-unprivileged:1.27-alpine` (non-root, port 8080, read-only filesystem with `/tmp` as tmpfs).
  - nginx's security headers (CSP, HSTS, X-Frame-Options…) were set at server level, but the `/` and asset
    locations had their own `add_header`, and nginx then drops the inherited ones. `index.html` and all assets were
    served without a CSP. The headers now live in `deploy/security-headers.conf`, included in each such location.
- **Angular `inlineCritical` is off in production.** With the CSP actually applied, Chrome blocked the inline
  `onload` handler that critical-CSS inlining adds to the stylesheet link. Turning inlining off is simpler than
  loosening `script-src`. Cost: the stylesheet loads normally instead of after first paint, a small
  difference for an app behind a login.

### Step 7: Tests
- **The sample sheet and the worker's parsing moved out of UI code** into `core/import/sample-sheet.ts` and
  `core/import/parse-sheet.ts`. The tests run the same path a real upload takes (rows → .xlsx bytes →
  `parseSheet` → `suggestMapping` → `buildInvoices` → `validateInvoice`). They assert that the sample's three
  deliberate mistakes, and only those, are caught.
- **Web tests use the existing `ng test` (Vitest, jsdom) runner**, not a separate Vitest config.
- **"Every endpoint" is enumerated, not listed by hand.** `app.ts` mounts routers from an exported `ROUTERS`
  list. `security.test.ts` derives every `METHOD /path` from it and fails if a route has no case, so a new
  endpoint must be added to the token sweep and the isolation matrix.
- **Tenant isolation is checked as "B is byte-for-byte unchanged".** Every business-scoped route is called with
  B's business id, and every `:id` route with B's record ids under A's business. Each must return 404 (upserts
  that reuse B's ids return 409). A snapshot of all of B's rows must match afterwards, and B's token must never reach FBR.
- **Bug found and fixed: duplicate jobs for one invoice.**
  - What went wrong: a second job that found the invoice in `posting` assumed a crash and marked it `outcome_unknown` while the first job's post was still in flight. The UI would then invite "post again", a real duplicate risk.
  - How it can happen: duplicate jobs arise when ioredis resends a queue add whose reply was lost.
  - The fix (`queue/inflight.ts`): the job claims a Redis marker with its job id inside the row-locked transaction, before `posting` commits. A different job that finds `posting` with a live marker leaves the invoice alone. The same job id (BullMQ's re-run after a crash) or no marker still means `outcome_unknown`.
  - The marker is released only after the outcome is stored. The compose SIGKILL test still passes.
- **A payload contract test** (`test/contract.test.ts`) reads `FbrItem` and `FbrInvoicePayload` from
  `rasid-web/src/app/core/models.ts`. It fails if the API's zod schema or the worker's payload builder drifts from those names.
- **One timing assertion relaxed.** The posting test's "exactly 3 in flight" became "at most 3, and at least 2". On a
  loaded machine, three jobs don't always overlap within one fake FBR call; the guarantee is the upper bound.
- **`xlsx` now comes from SheetJS's own CDN: 0.20.3, the current release.**
  - Why: 0.18.5 from npm had high-severity advisories (prototype pollution, ReDoS) and failed CI's `npm audit --omit=dev --audit-level=high`. SheetJS no longer publishes to npm, and fixed versions exist only at cdn.sheetjs.com.
  - How it's pinned: `package.json` points at `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, and `package-lock.json` keeps that tarball's sha512 integrity hash, so `npm ci` (CI and the Docker build) rejects a changed file.
  - Upgrading: change the URL; `npm outdated` won't report new SheetJS releases.
  - Checked with web tests (real XLSX round-trip), the production and Docker builds, and the browser e2e (sheet parsed in the Web Worker, offline and against the API). Audit: 0 vulnerabilities.

## Milestone 2

### Live reference data
- **Rasid uses its own PRAL token for reference lists, never a customer's.** (Step 1 below adds a customer's tested token as the fallback.) Reference lists are the same for
  every taxpayer, and FBR attributes calls to the token's owner. The token is stored like customer tokens:
  sealed with the vault (AAD `platform:reference`) in `reference_credential`. The table owner writes it with
  `node dist/reference-cli.js set-token`, which reads stdin (hidden at a terminal), checks the token against
  FBR before saving, and audits the change. The API role can only read the ciphertext. An environment variable
  would have been simpler, but it's plaintext on disk, which the brief rules out.
- **Without that token nothing breaks.** The endpoints answer `source: "none"` and the web app uses its bundled
  lists, as before. The worker logs a skipped refresh.
- **Cache in Postgres, not Redis:** `ref_lists` holds PRAL's responses as returned (jsonb, keyed by kind, query
  without the date, and the date asked for). `hs_codes` holds `itemdesccode` as rows for search. Both are shared
  by every tenant, so there's no RLS. The API role can write them, because lookups cache what they fetch.
- **Nightly job = a BullMQ job scheduler** in the worker (`REFERENCE_REFRESH_CRON`, default 02:00 since step 1 below, was 02:30
  Asia/Karachi). The scheduler adds one job per tick however many workers run. A worker that starts with an
  empty cache queues a one-off fill (fixed job id, so workers starting together queue it once).
- **What the night fetches:**
  - provinces, uom, transtypecode, itemdesccode.
  - SaleTypeToRate for each of Rasid's 24 sale types × each province, for that day.
  - SroSchedule for every rate found, then SROItem for every schedule.
  - HS_UOM only for HS codes someone has looked up. It's one call per code, and there are ~12k codes.
  - About 200–400 calls, 4 at a time.
- **Bad answers don't replace good data.** An empty list is a failure, and so is an HS list less than half the
  cached size. In both cases the cached copy stays. Each list is stored on its own, so one failure doesn't stop
  the rest. A 401 stops the run.
- **Dated copies are kept 35 days** (pruned by the refresh), so backdated invoices can still find the rates of their date.
- **Lookups: cache, then live, then nearest date.** On a miss, the API fetches from PRAL with the reference token,
  with a 5 s timeout and no retries (a slow FBR can't stall the editor), and caches the answer. If that fails,
  dated lists use the nearest earlier cached date (or the newest), and the response carries `asOf`. A failed live
  fetch isn't repeated for a minute per list and API process.
- **Sale type → PRAL transaction type is matched on letters and digits** of the description, case-insensitively
  ("Processing/ Conversion of Goods" = "Processing/Conversion of Goods"). Rasid sale types PRAL doesn't list are
  left out of the response, and the web app keeps their bundled rates. The API's list of sale types is
  `KNOWN_SALE_TYPES` (`fbr-payload.ts`). A contract test checks that it equals rasid-web's `SALE_TYPES`.
- **PRAL field names are read case-insensitively** (`hS_CODE`, `ratE_DESC` …, spec v1.12 section 5), so a
  casing change on PRAL's side doesn't empty a list. The shapes are checked against a fake PRAL in tests, not the
  live sandbox; check them once with a real token (`reference-cli refresh`, then `status`).
- **Province names stay as Rasid stores them** ("Punjab"); PRAL's codes are matched by name ("PUNJAB"). The web
  app keeps its seven names and doesn't replace them with PRAL's capitalised ones, so existing customers and
  checks stay valid.
- **The old `GET /api/fbr/:businessId/reference/:kind` proxy is removed.** It used the customer's token and
  cached in process memory. Nothing in the web app called it.
- **HS search** (replaced by `tsvector` in step 1 below) (`GET /api/reference/hs-codes?q=`): digits match the start of the code, with or without the dot;
  words must all appear in the description. Code matches come first. It's a plain `ILIKE` over ~12k rows, with no
  trigram index; add one if it shows up in latency.
- **Web: `ReferenceService`, lazily loaded.** Rates and the UOM list load the first time a form reads them, for the
  active business's province and today's date. They load again when the business, its province or the day changes.
  `PostingService` only reads HS→UOM rules it already has, so it never triggers requests.
  - Rates are for today, not each invoice's date. Rates rarely change, and FBR's validate is the final check.
  - HS→UOM rules are fetched when an HS code is entered in the editor or picked on the products page.
    `validateInvoice` uses them: 0096 when one unit is allowed, 0099 when there are several. Bulk import still
    checks only the bundled rule, so it doesn't make one request per HS code in a large sheet.
- **`SaleTypeDef.rates` is renamed `offlineRates`,** so nothing can read a hard-coded rate by accident. Scenario,
  retail-price and exempt flags stay in `fbr-reference.ts`, because PRAL's lists don't carry them.
- **A new invoice moves to PRAL's default rate when the rates arrive** after it was set up (reload straight onto
  `/invoices/new`). This happens once, when the rates load, so a rate the user then picks is left alone. Existing
  drafts are never changed.
- **SRO fields get suggestions, not a picker.** Schedules (for a PRAL rate) and their items fill `<datalist>`s when
  the field gets focus. Free text still works, because FBR's SRO numbering has odd cases.

### Step 1: reference cache, revisited against the brief
The first pass above was built before the milestone brief was checked line by line. This step closes the gaps in
the brief's step 1. Where the brief and the first pass disagreed, the choices below were confirmed with the product owner.
- **Token: Rasid's own first, a customer's as fallback.** The brief asked for "any business's valid token,
  production preferred". The first pass used only Rasid's token. Now `referenceToken()` (`reference/token.ts`)
  returns Rasid's token if set. Otherwise it returns one customer token whose last test passed (`last_ok_at`),
  production first, then the most recently tested. "Valid" means tested: a token that was saved but never tested
  isn't used. RLS stops the API role reading another tenant's credentials, so a `SECURITY DEFINER` function
  `reference_fallback_credential()` returns that one row. It returns only the ciphertext, which opens only with the
  original business's AAD. A 401 from FBR clears that token's `last_ok_at` (`reference_fallback_rejected()`), so
  it stops being a fallback until its owner tests it again. The token never reaches the browser. FBR attributes these
  calls to the customer, which is why Rasid's own token comes first. The legal opinion in the README covers this.
- **Tables kept, not renamed.** The brief's `reference_data(kind, key, payload, fetched_at, source_env)` is
  `ref_lists(kind, params, as_of, data, fetched_at, source_env)`: `params` + `as_of` is the key, so dated lists
  keep one row per date. HS codes stay in their own `hs_codes` table because they're searched. Both gained
  `source_env`: `platform` (Rasid's token), `production` or `sandbox` (a customer's).
- **Two more lists:** `doctypecode` and `sroitemcode` are fetched nightly and served from `GET …/reference/:kind`.
  `itemdesccode` isn't served whole (~12k rows); it's searched.
- **12 h expiry for parameterised lookups** (SaleTypeToRate, HS_UOM, SroSchedule, SROItem; `REFERENCE_TTL_HOURS`).
  An older copy is fetched again on request. If that fails, the old copy is still served: stale rates beat none,
  and FBR's validate is the final check. Lists without parameters change only with the nightly refresh.
- **An empty answer never replaces a non-empty copy**, in the refresh or in a lookup (`writeList` updates only
  when the new list has rows or the cached one has none). The first fetch of a list that really is empty is
  still stored. Each list FBR fails or empties is logged as a warning (`reference_list_kept`,
  `reference_lookup_failed`, `reference_empty_kept`).
- **Routes moved under the business,** `/api/businesses/:businessId/reference/…`, as briefed: `/rates`, `/hs`,
  `/uom-for-hs`, `/sro`, `/sro-items`, `/status` and `/:kind`. `province` and `date` are optional and default to
  the business's province and today in Pakistan. `/rates` without `saleType` returns every sale type, which is
  what the web app loads. The old `/api/reference/*` routes are gone. All are GET only.
- **HS search uses `tsvector`.** `hs_codes.search` is a generated `to_tsvector('simple', code || ' ' || description)`
  with a GIN index. The `simple` config means no stemming: PRAL's descriptions are tariff text, and English stemming
  would only blur trade terms. Each word is matched as a prefix (`sug` finds SUGAR). Only letters and digits are
  passed to `to_tsquery`. A query of digits (dots ignored) matches the start of the code, using an index on
  `replace(code, '.', '') text_pattern_ops`. The default limit is 20, the maximum 50.
- **The refresh takes `retry`** (default true), so tests can check a 500 without fbr-client's 15 s back-off.

### Step 2: sale type → transaction type (`sale_types`)
- **Seeded without transaction type ids.** The brief asks for a seed mapping each sale type to a `transTypeId` from
  `transtypecode`. Those ids exist only in PRAL's live list: the spec doesn't print them, and the ids in Rasid's
  tests are made up. Seeding ids would mean guessing. So migration 0006 seeds the 24 sale types with their scenario
  (SN001–SN025 primary scenarios) and the `usesRetailPrice` / `exempt` flags (`src/lib/sale-types.ts`, which a
  contract test checks against rasid-web's `SALE_TYPES`). Every row starts `needs_review` with no id.
- **The id is filled only when the match is certain:** exactly one `transtypecode` description equals the name,
  compared on letters and digits, ignoring case. This runs after every refresh, after a live fetch of
  `transtypecode`, and on the first rates request if it has never run. No match, or several ids for one name, leaves
  the id empty, `needs_review = true`, and a `review_note` naming the candidates. That sale type is left out of
  `/rates`, so the web app keeps its bundled rates for it. Nothing is matched on similarity alone.
- **Operators confirm by hand:** `reference-cli map-sale-type "<name>" <id>` (table owner, audited) sets the id and
  `confirmed_at`. The automatic match never changes a confirmed row. An id not in the cached `transtypecode` is refused.
  `auto` hands the row back to the automatic match. `reference-cli sale-types` and `GET …/reference/status`
  (`saleTypesNeedingReview`) show what's open. The API role may update only the match columns; a check
  constraint stops a row being marked reviewed without an id.
- **SCENARIO_BY_SALE_TYPE in fbr-payload.ts** is now derived from the same seed module. Scenarios SN002 and
  SN026–SN028 are buyer-type variants. They stay in rasid-web's `SCENARIOS`, not in `sale_types`.

#### To confirm with PRAL (product owner)
Until the first refresh with a real token, all 24 rows need review. After it, run `reference-cli sale-types` and
confirm every row that still has `needs_review`. These rows are uncertain on their own wording, whatever PRAL returns:
1. **Goods as per SRO.297(|)/2023** (SN024): the spec writes "(|)", which is most likely "(I)". A mismatch is never
   matched automatically, so confirm the id by hand.
2. **Non-Adjustable Supplies** (SN025): Rasid's scenario text for SN025 is "Drugs at fixed ST rate (Eighth Schedule,
   serial 81)". That doesn't obviously describe non-adjustable supplies. Confirm which sale type SN025 expects.
3. **Services**, **Services (FED in ST Mode)**, **Telecommunication services** (SN019, SN018, SN010): sales tax on
   services is provincial. If PRAL lists a transaction type per province or authority, there will be several matches
   for one name. Confirm which id applies to which seller.
4. **Goods (FED in ST Mode)** (SN017): confirm that one transaction type covers all FED-in-ST-mode goods.
5. **Sandbox scenarios for unregistered buyers:** `toPayload` picks a scenario by sale type only. A sandbox
   standard-rate invoice to an unregistered buyer is therefore tagged SN001, not SN002 (or SN026 for a retailer),
   unless the invoice sets `scenarioId`. Confirm whether PRAL's sandbox needs SN002/SN026 there. This affects
   sandbox only; production sends no scenario.

### Step 3: frontend
- **One more read-only route, `GET …/reference/hs-check?codes=a,b,…`** (up to 100). It says which codes FBR's HS list
  has and which units each allows. Bulk import needs this for a whole sheet. One search plus one `uom-for-hs` per
  code would be hundreds of requests. Unit lookups behind it go through the same 12 h cache, 6 at a time.
- **ReferenceService caches every PRAL answer for 24 h**, in memory and in IndexedDB (`ReferenceCache`,
  database `rasid-reference`). The key is the path and query, without the business, because the data is the same
  for every business. `source: "none"` answers and failed requests aren't kept, so they're tried again. Where
  IndexedDB isn't available (private windows, tests) the cache is memory only. Offline mode never calls the API
  and keeps the bundled lists.
- **Rates are per invoice date now:** `rates(saleType, date)` loads that date's PRAL rates for the seller's province
  the first time it's read. The editor's rate dropdown and the 0046 check use the invoice's date, not today.
- **The HS type-ahead** (`shared/hs-typeahead.component.ts`) is a combobox on a CDK connected overlay. It searches
  200 ms after the last keystroke and lists "code · description". ↑/↓ move, Enter picks, Esc closes, and the ARIA
  combobox attributes are set. A complete code (0000.0000) doesn't search. The invoice editor's HS cell and the
  products page both use it. The CDK overlay CSS is imported in `styles.scss`.
- **Units follow the HS code.** A complete code is checked with `hs-check`. When FBR allows one unit, the line
  switches to it. When it allows several, the unit list narrows to them and a wrong unit is flagged (0099), not
  silently changed. The products page picks the first allowed unit, because a product has no validation step.
- **SRO fields become dropdowns** when PRAL has schedules for the line's rate on the invoice date. They load whenever
  the sale type, rate or date changes, and the extra fields open by themselves. Without schedules the fields stay free
  text, as before. A value already on the line stays in the list.
- **validateInvoice takes `ReferenceChecks`** (`ReferenceService.checks()`): HS→UOM, `hsKnown` and `liveRates`.
  This adds 0052 (HS code not in FBR's list) and 0046 (rate not in PRAL's list for that sale type and date). Each check
  is skipped when there's no PRAL data, so the offline demo and sale types still needing review behave as before.
  `checks()` only reads, so PostingService still never triggers requests.
- **Bulk import review** runs the cache checks as soon as the sheet is mapped: one `hs-check` call per 100 distinct
  codes and the rates for each distinct invoice date. The errors appear on the same cells as before. "Validate with
  FBR" waits for these checks, so FBR only sees invoices that pass them.

