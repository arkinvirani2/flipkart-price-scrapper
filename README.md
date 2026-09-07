# Flipkart seller price scraper

Compares the price headlined on a Flipkart product page against a **specific seller's**
price inside the "See other sellers" list.

There are two ways to run it: a **CLI** (below, under "Usage") and a **web dashboard**
(next section). Both drive the exact same scraper. The CLI keeps its own NDJSON journal on
disk; the dashboard's batches live in Postgres and are scraped by a worker in GitHub
Actions.

## How it is deployed

Three tiers that never share a process:

```
Browser ──HTTP──> Vercel  (Next.js UI + short-lived API routes)
   │                 │
   │                 ├──REST──> Supabase Postgres
   │                 └──repository_dispatch──> GitHub Actions
   │
   └──WebSocket (anon key)──> Supabase Realtime  [jobs, job_results]

GitHub Actions ──service-role──> Supabase Postgres
        └── Playwright / Chromium  (the scraper, unchanged)
```

- **Supabase** is the record of truth. Batches, uploaded rows, results and recommendations
  are tables; there is no shared filesystem and nothing authoritative in memory.
- **GitHub Actions** is the scraper's runtime. It runs twice a day on a schedule, and the
  dashboard's Start button pokes it awake. Nothing needs to stay on for a batch to run.
- **Vercel** serves the UI and a handful of routes that read and write Supabase. Playwright
  is not in that deployment at all.

Setup instructions for all three are in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

```
scraper/
  selectors.ts     every Flipkart selector — the only file a DOM change should touch
  types.ts         input/output shapes
  utils.ts         logging, retry, condition-polling, option defaults
  parser.ts        price/name parsing + comparison (pure, browser-free)
  buyboxProbe.ts   who holds the buy box, read off the raw HTML before anything renders
  productPage.ts   openProduct, getMainPrice, findSellerListEntry
  sellerDrawer.ts  openSellerDrawer, extractSellers, clickShowMoreUntilSellerFound, getSellerPrice
  scraper.ts       scrapeProduct / scrapeProducts orchestration
  index.ts         public exports + CLI
  verify.ts        selector regression suite against the saved HTML snapshots
```

## Setup

Node 20 or later.

```bash
npm install
npx playwright install chromium   # only if you want to run the scraper locally
cp .env.example .env.local        # then fill in your Supabase project's values
```

Chromium is no longer installed by a `postinstall` hook. It was being downloaded on every
`npm install`, Vercel's build included, and the frontend has no use for it — the workflow
installs it explicitly instead, with a cache.

## Dashboard

A Next.js control panel over the same scraper: upload a seller listing XLS/XLSX file, review the validation,
start the batch, watch it live, pause/resume/stop, and export CSV/XLSX — no terminal.

```bash
npm run dev            # http://localhost:3000  (development)
# or
npm run build && npm start   # production
```

The dashboard needs a Supabase project to talk to, including in development — see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Starting a batch from a local dashboard still
queues it for a GitHub Actions runner; to scrape it on this machine instead, run
`npm run worker` against the same database.

Then: **New batch** → enter the target seller → drop the seller listing XLS/XLSX → drop the minimum settlement XLS/XLSX → review → **Create batch** → **Start**.

### Workflow

1. **Upload** a seller listing spreadsheet and a minimum settlement spreadsheet. The listing
   sheet provides `Seller SKU Id`, `Flipkart Serial Number`, and `Bank Settlement`; the
   minimum settlement sheet provides `FSN` and `Minimum Bank Settlement price`. Matching FSNs
   fill `bankSettlementThreshold`. `targetSeller` is entered manually on the upload page and
   applied to every row. The converted rows are validated for required fields, duplicate rows
   (same sku + URL), invalid URLs, and numeric settlement fields — with every problem listed
   per-row before anything is created.
2. **Dashboard** — nine stat cards (total, pending, running, completed, succeeded, failed,
   success %, average time, estimated remaining, queue length).
3. **Live progress** — current product, step, per-product and batch progress bars,
   elapsed time, ETA, browser status, current seller and URL.
4. **Controls** — Start · Pause · Resume · Stop. All four are *requests*: the scraper is on
   another machine, so each one is written to the batch row and acted on when the worker
   next looks. The dashboard shows that gap rather than hiding it.
   - **Start / Resume** queues the batch and asks GitHub for a runner. A runner has to boot
     and install Chromium first, so the batch sits in **Queued** for a minute or so.
     Resume continues from the first unfinished product; completed products are never
     re-scraped, and rows that ended `BLOCKED` are retried.
   - **Pause** is seen within a few seconds. Workers stop taking new products and finish the
     ones already in flight, so nothing nearly-done is thrown away — up to one product's
     time on a wide pool. The batch shows **Pausing** until then.
   - **Stop** is seen just as quickly and closes the browser contexts, which is what
     releases a page parked inside a navigation wait. Products in flight are left pending
     (not recorded as failures) so a later resume scrapes them cleanly. Fast, but not
     instantaneous.
5. **Queue** — virtualized table (handles thousands of rows), with filters for status, SKU,
   FSN, seller, URL, date, duration and failure reason, plus global search.
   - **Settlement** — three virtualized lists driven by the per-product bank-settlement
     figures. Difference is `currentPrice − sellerPrice`; `finalBankSettlement =
     currentBankSettlement + difference`. Rows land in **Main** (final ≥ threshold),
     **Below threshold** (final < threshold), or **Needs review** (not yet scraped, failed,
     or missing inputs — each with a reason). Any row opens its Flipkart Seller Hub listing.
6. **Failed** — failure status, the message explaining it, and per-row or bulk retry.
   There are no failure screenshots: the worker runs on a GitHub Actions runner whose
   filesystem is destroyed when the job ends, so a screenshot would have to be uploaded
   somewhere to outlive the run, and that was deliberately not built. The status and
   message are where the diagnosis lived anyway.
7. **Analytics** — outcome, scrape-time distribution, products per hour, failure reasons,
   seller distribution. All of it is one SQL call.
8. **Export** — CSV or XLSX with every scraper field; respects the active filters.

There is no Logs tab. Log lines go to the worker's stdout, which in GitHub Actions is the
workflow run's console log — open the run from the Actions tab to read a batch's narrative.
What survives a run in the database is the per-product `status` and `message`.

### Crash recovery

Every result is one committed row, written before the next product starts, so a worker that
dies mid-batch loses only whatever was in flight.

A running worker holds a **lease** on its batch and extends it every minute. A lease that
stops being extended is, by definition, a worker that stopped — a cancelled workflow, a
runner that ran out of memory, a job that hit its timeout. The next worker to start reaps
those: the batch becomes **Interrupted** and the dashboard offers **Resume**. The lease is
also what stops two runners writing results for one batch, since claiming is a conditional
`UPDATE` that only one of them can win.

### Where dashboard data lives

Supabase Postgres. One row per batch in `jobs`, one per uploaded product in `job_inputs`,
one per scraped result in `job_results`, one per recommendation in `recommendations`, and
the learned per-FSN history in `fsn_intelligence`. Deleting a batch cascades to everything
it wrote — except `fsn_intelligence`, which is authoritative and outlives it.

The schema is in `supabase/migrations/`, in the order it should be applied.

### Deployment — read before hosting

The dashboard deploys to Vercel and the scraper does not. That split is the whole design:
Playwright needs a persistent process and a real Chromium binary, and a batch runs for tens
of minutes — orders of magnitude past any serverless function timeout. So the scraper runs
as a standalone worker in GitHub Actions, and the Vercel deployment contains no Playwright
at all.

One batch runs at a time, still by design: two uncoordinated batches would multiply the
request rate from one address with nothing sharing their back-offs. That is enforced twice
— the workflow's `concurrency: scraper` group stops a second runner booting, and
`claim_job()` is a conditional `UPDATE` that only one runner can win even if two do.

Within a batch the scraper runs up to `concurrency` workers (dashboard default 20; CLI
default 3) that share one block gate and are paced per worker. How many of them scrape *at
once* is decided by the machine, not the setting — see **Pool width** below. A GitHub
runner is four cores and 16 GB shared with Chromium, and ten contexts is roughly 2 GB, so
the worker clamps whatever the batch asks for to `WORKER_MAX_CONCURRENCY` (default 8, set
in the workflow). Raising a pool past what the host can render does not make a batch finish
sooner; measured, it retires *fewer* products per second and stretches each one, which is
how machine load turns into `SELLER_LIST_LOAD_FAILED` rows.

One risk worth knowing about up front: **Flipkart rate-limits and bot-walls by IP, and
GitHub's runners use Azure datacentre addresses.** If batches start coming back full of
`BLOCKED` rows, set the `PROXY_URL` secret to a residential proxy — the plumbing is already
there and needs no code change. Until that happens, runs go out directly.

Full setup — Supabase, Vercel, GitHub — is in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

## Usage

```bash
# one product
npm run scrape -- --url "https://www.flipkart.com/..." --seller "AYANSHENTERPRISEE" --sku SKU12345 --fsn FSN98765

# batch: inputs.json is an array of { productUrl, targetSeller, sku, fsn }
npm run scrape -- --file inputs.json --out results.json

# watch it work
npm run scrape -- --url "..." --seller "MALBEC" --headed

# large batch (hundreds to thousands of products)
npm run scrape -- --file inputs.json --out results.json --delay 1500 --resume
```

Programmatic:

```ts
import { scrapeProduct } from './scraper';

const result = await scrapeProduct({
  productUrl: 'https://www.flipkart.com/...',
  targetSeller: 'AYANSHENTERPRISEE',
  sku: 'SKU12345',
  fsn: 'FSN98765',
});
```

### Output

```json
{
  "fsn": "FSN98765",
  "sku": "SKU12345",
  "sellerName": "AYANSHENTERPRISEE",
  "mainPrice": 122,
  "sellerPrice": 135,
  "difference": 13,
  "isPriceDifferent": true,
  "productUrl": "https://www.flipkart.com/...",
  "status": "OK",
  "sellersScanned": 24,
  "showMoreClicks": 2,
  "source": "dom",
  "durationMs": 9184
}
```

`difference = sellerPrice - mainPrice`. Positive means the seller is dearer than the
headline price.

Failures never throw — they come back with `mainPrice: null`, `sellerPrice: null`, and a
`status` of `PRODUCT_UNAVAILABLE`, `NO_SELLER_LINK`, `SELLER_LIST_LOAD_FAILED`,
`SELLER_NOT_FOUND`, `MAIN_PRICE_NOT_FOUND`, `SELLER_PRICE_NOT_FOUND`, or `ERROR`, plus a
human-readable `message`. The CLI exits non-zero when nothing succeeded.

## What the supplied HTML told us

Both snapshots were parsed before a line of scraping code was written. The findings drove
the design:

| Finding | Consequence |
| --- | --- |
| The product page carries `<script type="application/ld+json" id="jsonLD">` with `offers.price` (236), `sku`, and `availability` | **Primary price source.** Immune to CSS churn. DOM scraping is the fallback, not the default. |
| "See other sellers" is a real anchor: `<a href="/sellers?pid=KMTHGNNHMYWQHJN7">` | We navigate straight to `/sellers?pid=…` instead of clicking. Faster, and no overlay can intercept a navigation. Clicking remains the fallback. |
| Flipkart serves **two completely different seller layouts** | Both are supported; see the table below. |
| The name node is rendered **twice** per compact card (responsive duplicate) — 20 nodes for 10 sellers | Always take the first match within a card. |
| The paginator is `<button class="xqOMQN">show more</button>` — lowercase, and that class is **shared with an unrelated "Got it" tooltip button** | "Show more" is matched by *text/role*, never by class. Verified to match exactly 1 element. |
| PDP price classes are generated hashes (`v1zwn21l v1zwn20`) | Treated as low-trust fallback only. |
| The page opens with a **sponsored carousel**, so the first `₹` in the document is an ad's ₹265, not the real ₹236 | A naive whole-page price sweep is *wrong*. The fallback anchors to the `<h1>` product title and takes the first currency value after it. This bug was caught by the regression suite. |
| Desktop seller cards embed bank-offer copy — "Flat ₹50 off", "₹75 Cashback" — **inside the same card as the price** | Picking the *lowest* currency value in a card reports TREVIAA at ₹50 against a true ₹200. Both fallbacks take the **first** value in document order instead: price always precedes MRP, which precedes offers. Caught by the regression suite. |

### The two seller layouts

| | Compact (`after-click-see-more-seller.html`) | Desktop (`all-sellers.html`) |
| --- | --- | --- |
| Card | `div.eXlcRr` | `div.QGdlvi` |
| Name | `div.b1jAQQ` (duplicated) | `div.zCSLD9 > span` |
| Price | `span.XVCSsK` | `div.hZ3P6w` |
| Struck MRP | `span.RdHagW` | `div.kRYCnD` |
| Pagination | `show more` button | none — all sellers at once |
| In-card bank offers | no | **yes — poisons lowest-price extraction** |

`selectors.ts` lists both sets; the extractor takes the first selector that matches
anything, so compact selectors simply find nothing on a desktop page and vice versa.

### Is there a seller API?

The snapshots contain **no** server-rendered seller JSON — `window.__INITIAL_STATE__`
appears only inside bootstrap script bodies, with no seller records — so a
network-only approach cannot be assumed to work.

The scraper still attaches an opportunistic response sniffer
(`attachNetworkCapture`) that watches JSON responses and deep-scans them for objects
carrying a seller name *and* a price *and* a `sellerId`/`listingId`. If a payload yields
the target seller, the entire click loop is skipped (`source: "network"`). Otherwise it
falls back to DOM scraping (`source: "dom"`). **Off by default** — across 13,150 recorded
products it resolved none of them, while buffering the JSON body of every response whose
URL merely looked seller-ish. Opt in with `--network`.

If you can capture a HAR while the seller list loads, drop it in and the URL hints in
`selectors.ts` (`SELLER_API_URL_HINTS`) can be narrowed to the real endpoint — that's the
5–10× win, and the hook for it is already wired.

## Design notes

**No fixed sleeps.** `utils.waitFor` polls a *condition* and returns the instant it holds;
the only fixed numbers are timeout ceilings. The "Show more" loop waits on the seller count
actually increasing, which is what makes spinners and lazy loading a non-issue.

**The Show More loop is state-driven, not count-driven.** It stops when the seller is
found, when the button is gone, or when a click stops producing new rows.
`maxShowMoreClicks` (default 40) is purely a runaway guard.

**Two independent seller-lookup strategies.** Structured extraction via the card classes,
plus a text-anchored search that finds the element whose text *is* the seller name and
walks up to the nearest ancestor containing a price. The regression suite strips every
card class and confirms the anchored path still returns the right price — so a Flipkart
class rename degrades the scraper rather than breaking it.

**Multiple prices in one card** are disambiguated with `getComputedStyle`, skipping
`line-through` (the MRP). Where structure is unavailable, the lowest currency-prefixed
value wins — ratings like "4.1" are excluded because the pattern requires ₹/Rs/INR.

**Seller names** are compared case-folded with punctuation and whitespace stripped, so
`"Shoppping Dil Se"` matches `ShopppingDilSe`.

**Wrong data is worse than no data.** When the price cannot be established confidently the
scraper returns `MAIN_PRICE_NOT_FOUND` rather than a plausible-looking guess.

**The buy box is asked first, and off the raw HTML.** See the next section — it is the
largest single saving in a batch, and the one place where the fast answer and the slow
answer are checked against each other in the regression suite.

## The buy box decides how much work a product needs

If the account already holds the buy box, the product page price *is* our price. Nothing is
being compared, the difference is zero, and the current bank settlement is the final bank
settlement. Everything after that question — the seller list, the "Show more" paging, the
price comparison — would only confirm a number already in hand.

So the question is asked before anything is rendered. Flipkart server-renders both facts the
answer needs — the `Fulfilled by <name>` line and a `<script type="application/ld+json">`
blob carrying the price, FSN and availability — so `buyboxProbe.ts` fetches the product page
as **HTML through the browser context** (same user agent, same cookie jar, no renderer) and
reads them out of the markup.

Two things follow from the answer:

- **The buy box is ours** → the product is finished right there, with `mainPrice`,
  `sellerPrice`, `mainListingIsAccountSeller: true` and a zero difference. No browser page
  is ever opened for it.
- **Someone else holds it** → the probe has already read the price, so the browser opens
  **straight onto `/sellers?pid=<FSN>`**. The product page is not rendered at all; it had
  nothing left to say.

A probe is an accelerator, never a verdict. A non-200, a missing `Fulfilled by` line, an
out-of-stock marker, a bot wall, unparseable structured data — each returns nothing, logs
why, and the product is rendered exactly as it was before the probe existed. So the worst a
probe can cost is one wasted HTML fetch, and no failure of it can change what a product
reports. `--no-buybox-probe` turns it off, which changes speed and nothing else.

Measured on 24 live products (7 already ours), four workers, idle browsing off:

| | probe off | probe on |
| --- | --- | --- |
| batch wall-clock | 29.5 s | **22.5 s** |
| median product we already win | 1744 ms | **662 ms** |
| median product we do not win | 4278 ms | **2890 ms** |

The second row is the point of the feature. The third is the side effect of never rendering
a product page: one render per product instead of two, which matters most on a full pool,
where the width controller is trading against exactly that cost.

One bonus, unrelated to speed: the `Fulfilled by` line is always in the served markup but is
not always in the rendered DOM when the extractor looks. Reading it from the HTML settles a
handful of products per hundred that the rendered read left to be inferred from the seller
list.

## Regression suite

```bash
npm run verify
```

35 assertions replayed against the three checked-in snapshots — parsing, both price paths,
all 10 compact sellers and all 5 desktop sellers with exact prices, the "show more"
disambiguation, the bank-offer price trap, the stripped-class resilience path, and the
comparison math.

Two things the harness does deliberately, both learned the hard way:

- **JavaScript is disabled.** The saved pages ship their own React bundle, which fails to
  hydrate offline and **blanks the DOM about a second after load** — with JS on, roughly
  8 KB of text collapses to 87 characters and every selector "breaks" for reasons that
  have nothing to do with your code.
- **Every non-local request is aborted.** The snapshots reference assets protocol-relatively
  (`//static-assets-web.flixcart.com/...`). Under `file://` those become Windows **UNC
  network paths** that hang for 30s+, and because the stylesheets are render-blocking,
  `domcontentloaded` never fires. Note the filter matches `file:///` with three slashes —
  a real local file has an empty host, the UNC form does not.

When Flipkart redesigns: re-save both snapshots, run `npm run verify`, and repair whatever
goes red in `selectors.ts`.

## Large batches

At roughly 4 s/product, 1000 items is a 1–3 hour run. Three things make that survivable:

- **Every result is journalled as it completes**, to an NDJSON file next to `--out`
  (`results.json` → `results.ndjson`, override with `--journal`). A crash at item 900
  loses nothing.
- **`--resume`** skips inputs already in the journal, keyed on SKU + product URL. Products
  that ended `BLOCKED` are *not* treated as done — that status describes the bot wall, not
  the product, so a resume retries them. A journal left half-written by a `Ctrl-C` is
  repaired on resume.
- **`--delay <ms>`** (plus `--jitter`, default 400) paces the run. Default is 0, which keeps
  small runs as fast as they were; use ~1500 for anything in the hundreds. 1000 back-to-back
  requests from one IP is what actually trips Flipkart.

If a product hits a captcha or a 403/429/503, the run pauses `--block-backoff` ms (default
60 s, doubling) and retries it up to `--block-retries` times (default 3). If it is still
blocked, the run **stops** rather than burning the remaining inputs against a wall — rerun
with `--resume` once you're unblocked.

Without `--resume`, an existing journal is deleted rather than merged, so two runs never
silently blend into one output file.

## Operational notes

- Batch runs use **one browser with `--concurrency` contexts** (CLI default 3, dashboard
  default 20, hard ceiling `MAX_CONCURRENCY` = 20). Every worker waits on a shared block
  gate, so a bot wall backs the whole pool off rather than one worker. `--concurrency 1`
  restores the old strictly-sequential behaviour. N workers means roughly N times the
  request rate from one address, so a batch that comes back with an unusual number of
  `SELLER_NOT_FOUND` / `SELLER_LIST_LOAD_FAILED` rows is worth rerunning on a smaller pool
  before its numbers are trusted.
- Worker starts are staggered by the run's own `delayMs` (floor `WORKER_RAMP_MS`, 750ms),
  so a twenty-worker pool does not open twenty contexts and fire twenty navigations at
  once — that burst is both the most block-prone moment of a run and the worst moment for
  CPU. The offset also keeps workers out of lockstep for the rest of the batch. It costs
  `(workers - 1) x delayMs` to bring the pool up (~28s at 20 workers and the default
  1500ms), paid once per run.
- **Pool width.** `concurrency` is a ceiling on workers, not a promise about how many run
  at once. Workers are browser contexts sharing the host's cores, and past the point where
  they saturate it another worker subtracts throughput instead of adding it. Measured on
  eight cores against the saved Flipkart markup, 24 products:

  | workers | 3 | 6 | 8 | 10 | 14 | 20 |
  |---|---|---|---|---|---|---|
  | products/sec | 1.11 | 1.60 | **1.77** | 1.66 | 1.77 | 1.28 |
  | per product | 1.9s | 3.8s | 4.2s | 5.9s | 6.6s | **15.5s** |

  That second row is why an over-wide pool also *fails* more: every wait in the scraper is
  wall-clock, so a product stretched to 15s runs its waits into the 20s action timeout and
  is recorded as `SELLER_LIST_LOAD_FAILED` or a seller "not found" — the run gets no
  faster and the output gets worse. So `PoolWidth` (scraper/poolWidth.ts) admits products
  against a width it tunes itself: it measures throughput at each width it tries and sits
  on the best one, re-checking the neighbours every few rounds because a host that is busy
  now may not be later. Equal throughput always keeps the *narrower* width, since the
  narrower one finishes each product sooner and that is what keeps products clear of their
  timeouts. `npm run test:width` covers convergence, the floor, the ceiling, and the gate.
- Timeouts scale with the live width (`pacedForWidth`, capped at 2.5x). A wait that expires
  because nineteen siblings were rendering is not a scrape failure, and on the happy path
  patience is free — every wait returns the moment its condition holds.
- A failure that describes the *run* rather than the listing gets one retry in a fresh
  context: `NO_SELLER_LINK`, `SELLER_LIST_LOAD_FAILED`, `MAIN_PRICE_NOT_FOUND`,
  `SELLER_PRICE_NOT_FOUND`, `ERROR`. `PRODUCT_UNAVAILABLE` and `SELLER_NOT_FOUND` are
  answers, not flakes, and are never retried — a second scrape for every correct negative
  would be paid on every batch.
- Pool size changes one wait, deliberately: `settleSellerCount`'s quiet window scales with
  the live width (300ms at 3 in flight, 1.2s at 10, 2.1s at 20). Every other wait expires
  into an honest failure that the dashboard can retry; that one expires into an *answer*,
  and a seller list declared complete while it was merely starved of CPU reads as "this
  seller does not sell this product" — a wrong number, not a visible failure. The loop
  polls `countSellerCards`, which counts exactly what `extractSellers` would return without
  reading a price or resolving a style, so the window is cheap enough not to feed the
  starvation it is compensating for.
- Row identity never depends on completion order: results are journalled under
  `sku + productUrl` and joined back to the uploaded rows by that key, so the Index column
  in the queue and in the recommendation export is always the uploaded position, whatever
  order twenty workers finish in. `npm run test:pool` is the regression test for that
  at the full `MAX_CONCURRENCY` width,
  including the retry path and one SKU listed under two FSNs.
- Images, media and fonts are dropped before they are fetched (`--no-block-resources`
  keeps them). CSS and JS are **never** blocked: seller cards mark the struck-through MRP
  with `line-through`, and `extractSellers` tells it from the selling price by asking
  `getComputedStyle`. Blocking CSS would silently report MRPs as selling prices.
- The buy-box probe (on by default, `--no-buybox-probe` to disable) reads the winning
  seller and the price out of the served HTML before a page is opened. Products the account
  already wins never open one; the rest go straight to the seller list. See "The buy box
  decides how much work a product needs".
- `--screenshot-dir <dir>` writes a screenshot for each failed product.
- Pass `storageStatePath` if you need a logged-in session.
- Flipkart's markup differs across A/B buckets and viewports — both known seller layouts
  are handled, and the text-anchored fallback covers a third we haven't seen.

## Where does the output go?

**Straight to your terminal as JSON** — nothing is written to disk by default.

To save it to a file instead, add `--out`:

```powershell
npm run scrape -- --url "https://dl.flipkart.com/s/HecE5QuuuN" --seller "TREVIAA" --sku "SKU12345" --fsn "STIHNUAYF3J8ZGHZ" --out result.json
```

The progress lines (`Opening product...`, `Seller found...`) go to stdout alongside it. Use
`--quiet` to print only the JSON, which is what you want when piping:

```powershell
npm run scrape -- --url "..." --seller "TREVIAA" --quiet | Out-File result.json
```

Exit code is `0` when at least one product succeeded, `1` otherwise — so shell and CI
callers can branch on it.

## Project layout

```
scraper/          the Playwright scraper — unchanged core, called by the CLI and the worker
  journal.ts      NDJSON journal + resume rule, used by the CLI
worker/           the standalone worker: claim a batch, scrape it, write to Supabase, exit
  index.ts        entry point (npm run worker)
  run.ts          the run itself — the port of the old in-process jobRunner
  control.ts      polls requested_action, extends the lease
  progress.ts     the throttled live-progress snapshot
supabase/
  migrations/     the schema, in the order it should be applied
app/              Next.js App Router — dashboard pages and API routes
components/       UI: dashboard, queue, charts, settlement, upload, shadcn primitives
lib/
  store/          jobStore, mappers, stats, ids, lease — all async over Supabase
  supabase/       the two clients (service-role, browser anon) and the row types
  services/       analytics, exports, recommendations, row filters, GitHub dispatch
  intelligence/   the learning engine and its store
hooks/            React Query + Supabase Realtime hooks
types/            dashboard types (re-export the scraper's own)
.github/workflows/scraper.yml   the scraper's runtime
docs/DEPLOYMENT.md              Supabase / Vercel / GitHub setup
```

Three TypeScript configs, because three things compile differently. `tsconfig.json` is the
Next.js app. `tsconfig.scraper.json` scopes the scraper for the CLI (`npm run scrape`,
`npm run verify`), so the dashboard build never changes how the scraper compiles.
`tsconfig.worker.json` spans both, since the worker imports the scraper *and* the store.

One constraint on all of them: anything that runs Playwright must run under **ts-node**, not
an esbuild-based runner like tsx. esbuild's `keepNames` rewrites function expressions to
reference a `__name` helper, and a function handed to `page.evaluate` is serialised and run
inside Chromium where that helper does not exist. The failure is a `ReferenceError` thrown
from the browser, a long way from its cause.
