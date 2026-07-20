# Flipkart seller price scraper

Compares the price headlined on a Flipkart product page against a **specific seller's**
price inside the "See other sellers" list.

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
npm install
npx playwright install chromium
```

## Usage

```bash
# one product
npm run scrape -- --url "https://www.flipkart.com/..." --seller "AYANSHENTERPRISEE" --sku SKU12345 --fsn FSN98765

# batch: inputs.json is an array of { productUrl, targetSeller, sku, fsn }
npm run scrape -- --file inputs.json --out results.json

# watch it work
npm run scrape -- --url "..." --seller "MALBEC" --headed
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
falls back to DOM scraping (`source: "dom"`). Disable with `--no-network`.

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

## Operational notes

- Batch runs are **sequential in one browser** on purpose; parallel tabs against Flipkart
  invite rate-limiting and captchas.
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



npm run scrape -- --url "https://dl.flipkart.com/s/HecE5QuuuN" --seller "TREVIAA" --sku "SKU12345" --fsn "FSN98765"

npm run scrape -- --url "https://dl.flipkart.com/s/7w2lrWNNNN" --seller "Anuttar" --sku "SKU12345" --fsn "STIHZG79HGFP5EXP"
