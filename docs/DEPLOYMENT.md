# Deployment

Three things to set up, in this order: **Supabase**, then **Vercel**, then **GitHub
Actions**. Each depends on values from the one before it.

Nothing here needs your PC to stay on. That is the point of the whole arrangement.

---

## 1. Supabase

### Create the project

1. <https://supabase.com/dashboard> → **New project**.
2. Pick a region close to you — `ap-south-1` (Mumbai) if you are in India. Every dashboard
   read is a round trip to it.
3. Save the database password somewhere; you will not need it for this app, but you will
   need it if you ever use the CLI.

### Apply the schema

Open **SQL Editor** and run the files in `supabase/migrations/` **in order**, one at a
time, checking each succeeds before the next:

| File | What it does |
|---|---|
| `0001_schema.sql` | The tables: `jobs`, `job_inputs`, `job_results`, `recommendations`, `fsn_intelligence`, `intelligence_processed_jobs`. |
| `0002_views.sql` | `job_rows_v` (the input/result join the UI renders), `job_stats_v` (the counts), and `job_analytics()`. |
| `0003_rls.sql` | Row level security, the grants, and adding `jobs` + `job_results` to the Realtime publication. |
| `0004_claim.sql` | `claim_job()`, `heartbeat_job()`, `release_job()`, `reap_stale_jobs()` — the lease. |
| `0005_retention.sql` | **Apply last, and only once the rest works.** The 30-batches-per-account prune. It is the only migration that deletes anything. |

If `0005` prints a notice about pg_cron not being available, enable it under **Database →
Extensions** and re-run that file — or just run `select public.prune_jobs(30);` by hand now
and then. Retention is tidy-up, not a correctness rule.

### Collect the keys

**Project Settings → API**:

- **Project URL** → `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_URL`
- **anon / public** → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- **service_role** → `SUPABASE_SERVICE_ROLE_KEY`

The service-role key bypasses RLS entirely. It belongs in exactly two places — Vercel's
server-side environment and GitHub Actions secrets — and nowhere else. Never give it a
`NEXT_PUBLIC_` prefix; that prefix is what puts a value in the browser bundle.

### What the anon key can do, and what that means

RLS grants `anon` **SELECT and nothing else**, on `jobs`, `job_inputs`, `job_results`,
`recommendations` and `fsn_intelligence`. Every write goes through a route or the worker
holding the service-role key.

Be clear-eyed about the read half: the anon key ships in the browser bundle and the app has
no login, so **anyone with your Vercel URL can read every batch, SKU, FSN, seller name and
price**. Nothing in this configuration prevents that; the only thing standing between the
data and the world is nobody guessing the URL. This was a deliberate choice for simplicity.

If you later want it private, it is a contained change: add a Supabase Auth login page and
swap `to anon` for `to authenticated` in `0003_rls.sql`.

---

## 2. Vercel

1. <https://vercel.com/new> → import the repository.
2. Framework preset: **Next.js**. Nothing else needs changing — no build command override,
   no output directory.
3. Set the environment variables below for **Production, Preview and Development**.

| Variable | Value | Exposed to browser? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL | Yes, by design |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key | Yes, by design |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key | **No** |
| `GITHUB_DISPATCH_TOKEN` | the PAT from step 3 | **No** |
| `GITHUB_REPO` | `your-user/flipkart-price-scrapper` | No |
| `ANALYTICS_TIMEZONE` | optional, default `Asia/Kolkata` | No |

Playwright is a devDependency, so Vercel's production install never downloads Chromium and
no route imports it. If you see Playwright in a Vercel build log, something has imported the
scraper into the app by accident.

`ANALYTICS_TIMEZONE` decides the buckets on the products-per-hour chart. It has a default
because the old code used the serving machine's local clock, which on Vercel would silently
have become UTC and shifted every bar.

---

## 3. GitHub Actions

### Repository secrets

**Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Required | Value |
|---|---|---|
| `SUPABASE_URL` | yes | Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Supabase service_role key |
| `PROXY_URL` | no | e.g. `http://user:pass@proxy.example.com:8000` — see below |
| `PROXY_USERNAME` | no | if not embedded in the URL |
| `PROXY_PASSWORD` | no | if not embedded in the URL |

### The dispatch token, so Start works from the dashboard

Without this the dashboard still queues batches — they just wait for the next scheduled run
instead of starting within a minute. The response says which happened, so you will not be
left guessing.

1. <https://github.com/settings/personal-access-tokens/new> → **Fine-grained token**.
2. **Repository access**: only this repository.
3. **Permissions**: `Contents: Read-only` and `Actions: Read and write`. Nothing else.
4. Set an expiry you will actually notice, and put the token in Vercel as
   `GITHUB_DISPATCH_TOKEN`.

It is used from one server-side module (`lib/services/githubDispatch.ts`) and never reaches
the browser.

### The schedule

`.github/workflows/scraper.yml` runs at `30 3,15 * * *` UTC — 09:00 and 21:00 IST. India has
no daylight saving, so those do not drift.

Two things about GitHub's scheduler that are worth knowing rather than discovering:

- It is best-effort and routinely runs **5–20 minutes late** under load.
- A scheduled workflow in a public repository is **disabled automatically after 60 days**
  with no repository activity. If batches quietly stop running, check this first.

A scheduled run does not invent work: it takes the oldest **queued** batch, and exits 0 with
"nothing to do" if there is none. An idle day is a green tick.

### Running it by hand

**Actions → Scraper → Run workflow**. The optional `job_id` input targets one batch; leave
it empty to take the oldest queued one.

---

## Local development

```bash
npm install
npx playwright install chromium     # only if you will run the scraper locally
cp .env.example .env.local          # fill in the Supabase values
npm run dev                         # http://localhost:3000
```

`.env.local` needs the two `NEXT_PUBLIC_*` variables and `SUPABASE_SERVICE_ROLE_KEY`. Do not
put `GITHUB_DISPATCH_TOKEN` in it unless you actually want a local Start button to fire a
real GitHub Actions run.

### Running the worker locally

Useful for watching a batch scrape without waiting on a runner. It talks to the same
database, so a batch you queue in the deployed dashboard can be scraped from your desk:

```bash
npm run worker                  # take the oldest queued batch
npm run worker -- --job job_x   # take a specific one
```

It reads `.env.local` then `.env`. It claims a lease exactly as the Actions runner does, so
the two cannot collide — whoever claims first gets the batch.

### The scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | the Next.js app |
| `npm run worker` | the scraper worker |
| `npm run scrape` | the standalone CLI, journal on disk, no database |
| `npm run verify` | 45 selector assertions against the checked-in HTML snapshots |
| `npm run test:store` | mappers, stats arithmetic, filter translation — no database needed |
| `npm run test:recommendation` | the settlement and recommendation maths |
| `npm run test:width` | the pool-width controller |
| `npm run typecheck` / `:worker` / `:scraper` | all three projects |

---

## Verifying it works, end to end

1. **Schema.** In the SQL editor: `select * from public.job_stats_v limit 1;` should return
   no rows and no error.
2. **The app reads.** Open the deployed dashboard. An empty batch list means the anon key
   and RLS are working; an error means one of them is not.
3. **Create a batch.** Upload the two spreadsheets. `select count(*) from job_inputs;`
   should match the row count you were shown.
4. **Start it.** The batch should go to **Queued** and the response should say a runner was
   triggered. Check **Actions** for a run that started within seconds.
5. **Watch it.** Rows should appear in the queue table without refreshing the page. If they
   only appear on refresh, Realtime is not connected — check that `0003_rls.sql`'s
   publication block ran, and that the two `NEXT_PUBLIC_*` values are set.
6. **Pause and Stop.** Both should take effect within a few seconds. Pause leaves the batch
   **Paused** with results saved; Resume should pick up exactly where it left off.
7. **Kill a run.** Cancel the workflow mid-batch. Within 15 minutes the batch should become
   **Interrupted** (or immediately, on the next worker start) and Resume should work.

---

## Known limitations

- **The data is publicly readable.** Covered above under RLS. It is a choice, not an
  oversight, but it is the one thing here most worth revisiting.
- **Flipkart may block the runner's IP.** GitHub's runners are Azure datacentre addresses,
  which e-commerce sites commonly treat as suspect. The symptom is a batch that stops early
  with `BLOCKED` rows; the fix is the `PROXY_URL` secret, which needs no code change. This
  has not been tested against Flipkart from a runner.
- **Start is not instant.** A runner boots and installs Chromium first — a minute or so.
- **Pause and Stop are requests.** The worker checks every three seconds and then has to
  wind down; a page already waiting on Flipkart takes a moment longer to release.
- **No failure screenshots and no stored logs.** Both were deliberately dropped. Log lines
  are in the Actions run's console output, and per-product `status` and `message` are in the
  database.
- **Free-tier limits.** Supabase free tier pauses a project after a week with no activity,
  which would stop the scheduled runs from finding a database. Two batches a day is plenty
  of activity, but a long quiet period is not.
- **Existing local data was not migrated.** The 40 batches under `data/` are untouched and
  are not visible in the deployed dashboard. Supabase starts empty.
