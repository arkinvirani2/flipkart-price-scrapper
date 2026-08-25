# Flipkart seller price scraper

Compares the price headlined on a Flipkart product page against a **specific seller's**
price inside the "See other sellers" list.

There are two ways to run it: a **CLI** (below, under "Usage") and a **web dashboard**
(next section). Both drive the exact same scraper and share the same journal format — a
batch started in one can be resumed by the other.

```
scraper/
  selectors.ts     every Flipkart selector — the only file a DOM change should touch
  types.ts         input/output shapes
  utils.ts         logging, retry, condition-polling, option defaults
  parser.ts        price/name parsing + comparison (pure, browser-free)
  productPage.ts   openProduct, getMainPrice, findSellerListEntry
  sellerDrawer.ts  openSellerDrawer, extractSellers, clickShowMoreUntilSellerFound, getSellerPrice
  scraper.ts       scrapeProduct / scrapeProducts orchestration
  index.ts         public exports + CLI
  verify.ts        selector regression suite against the saved HTML snapshots
```

## Setup

```bash
npm install            # also runs `playwright install chromium` via postinstall
```

## Dashboard

A Next.js control panel over the same scraper: upload a seller listing XLS/XLSX file, review the validation,
start the batch, watch it live, pause/resume/stop, and export CSV/XLSX — no terminal.

```bash
npm run dev            # http://localhost:3000  (development)
# or
npm run build && npm start   # production
```

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
4. **Controls** — Start · Pause · Resume · Stop.
   - **Pause** lets the current product finish and be saved, then stops the queue.
   - **Resume** continues from the first unfinished product; completed products are never
     re-scraped. Rows that were `BLOCKED` are retried.
   - **Stop** aborts immediately; the in-flight product is left pending (not recorded as a
     failure) so a later resume scrapes it cleanly.
5. **Queue** — virtualized table (handles thousands of rows), with filters for status, SKU,
   FSN, seller, URL, date, duration and failure reason, plus global search.
   - **Settlement** — three virtualized lists driven by the per-product bank-settlement
     figures. Difference is `currentPrice − sellerPrice`; `finalBankSettlement =
     currentBankSettlement + difference`. Rows land in **Main** (final ≥ threshold),
     **Below threshold** (final < threshold), or **Needs review** (not yet scraped, failed,
     or missing inputs — each with a reason). Any row opens its Flipkart Seller Hub listing.
6. **Failed** — reason, failure screenshot (view/download), and per-row or bulk retry.
7. **Logs** — timestamped, level-coded, searchable, filterable, downloadable.
8. **Analytics** — outcome, scrape-time distribution, products per hour, failure reasons,
   seller distribution.
9. **Export** — CSV or XLSX with every scraper field; respects the active filters.

### Crash recovery

The result journal is written to disk *before* the next product starts, so a browser
crash, a server restart, or a power cut can only ever lose the single product that was
in flight. On the next start the dashboard detects any batch that was mid-run, marks it
**Interrupted**, and offers **Resume** — completed products are already safe.

### Where dashboard data lives

Under `data/jobs/<jobId>/` (git-ignored): `job.json` (manifest), `inputs.json` (the upload
verbatim), `results.ndjson` (the same journal format the CLI uses), `logs.ndjson`, and
`screenshots/`. Delete a batch from its page to remove the whole directory.

### Deployment — read before hosting

This is designed to **run on one long-lived Node host** (your machine, or a container on
Railway / Render / Fly / a VPS). It is **not deployable to Vercel or any serverless
platform**: Playwright needs a persistent process and a real Chromium binary, a
1000-product batch runs for hours (far past any function timeout), and the crash-recovery
guarantee depends on a durable local disk. One *job* runs at a time by design — two
uncoordinated batches would multiply the request rate with nothing sharing their
back-offs. Within a job the scraper runs `concurrency` workers (dashboard default 10, the
maximum; CLI default 3) that share one block gate and are paced per worker. Keep the host
awake for the length of a batch, and size the host for the pool — ten contexts is roughly
2 GB of Chromium.

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
  default 10, hard ceiling `MAX_CONCURRENCY` = 10). Every worker waits on a shared block
  gate, so a bot wall backs the whole pool off rather than one worker. `--concurrency 1`
  restores the old strictly-sequential behaviour. N workers means roughly N times the
  request rate from one address, so a batch that comes back with an unusual number of
  `SELLER_NOT_FOUND` / `SELLER_LIST_LOAD_FAILED` rows is worth rerunning on a smaller pool
  before its numbers are trusted.
- Worker starts are staggered by the run's own `delayMs` (floor `WORKER_RAMP_MS`, 750ms),
  so a ten-worker pool does not open ten contexts and fire ten navigations at once — that
  burst is both the most block-prone moment of a run and the worst moment for CPU. The
  offset also keeps workers out of lockstep for the rest of the batch.
- Pool size changes one wait, deliberately: `settleSellerCount`'s quiet window scales with
  `concurrency` (300ms at 3 workers, 1.2s at 10). Every other wait expires into an honest
  failure that the dashboard can retry; that one expires into an *answer*, and a seller
  list declared complete while it was merely starved of CPU reads as "this seller does not
  sell this product" — a wrong number, not a visible failure.
- Row identity never depends on completion order: results are journalled under
  `sku + productUrl` and joined back to the uploaded rows by that key, so the Index column
  in the queue and in the recommendation export is always the uploaded position, whatever
  order ten workers finish in. `npm run test:pool` is the regression test for that,
  including the retry path and one SKU listed under two FSNs.
- Images, media and fonts are dropped before they are fetched (`--no-block-resources`
  keeps them). CSS and JS are **never** blocked: seller cards mark the struck-through MRP
  with `line-through`, and `extractSellers` tells it from the selling price by asking
  `getComputedStyle`. Blocking CSS would silently report MRPs as selling prices.
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
scraper/          the Playwright scraper — unchanged core, called by both CLI and dashboard
  journal.ts      NDJSON journal + resume rule, shared by the CLI and the dashboard
app/              Next.js App Router — dashboard pages and API routes
components/        UI: dashboard, queue, charts, logs, upload, shadcn primitives
lib/              store (job/log/paths), runner (jobRunner/eventBus), services, validation
hooks/            React Query + SSE hooks
types/            dashboard types (re-export the scraper's own)
data/             per-batch job data (git-ignored)
```

The scraper is scoped to its own `tsconfig.scraper.json`; the CLI scripts (`npm run scrape`,
`npm run verify`, `npm run typecheck:scraper`) use it, so the dashboard build never changes
how the scraper compiles.
