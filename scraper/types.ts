/**
 * Shared types for the Flipkart seller-price scraper.
 */

export interface ScrapeInput {
  productUrl: string;
  targetSeller: string;
  sku: string;
  fsn: string;
  /**
   * Per-product bank-settlement figures used only by the dashboard's settlement
   * view. The scraper reads none of these — they pass through untouched from the
   * inputs file to the journal-joined rows. Optional so older inputs stay valid.
   */
  currentBankSettlement?: number;
  bankSettlementThreshold?: number;
  /**
   * Flipkart's own "Benchmark Price" for this listing — its system-generated
   * read of a competitive price, from the same seller listing sheet. Zero is a
   * real value in that column and means Flipkart has no read, not ₹0.
   */
  benchmarkPrice?: number;
  /** "System Stock count". Zero orders on a zero-stock listing is not a price problem. */
  stockCount?: number;
  /**
   * The seller listing sheet's own "Your Listing Price" — the price as listed,
   * which is not always the price the product page ends up showing. The scraper
   * ignores it; it passes through for the recommendation's expected-price maths.
   */
  listingPrice?: number;
}

export type ScrapeStatus =
  | 'OK'
  | 'PRODUCT_UNAVAILABLE'
  | 'NO_SELLER_LINK'
  | 'SELLER_LIST_LOAD_FAILED'
  | 'SELLER_NOT_FOUND'
  | 'MAIN_PRICE_NOT_FOUND'
  | 'SELLER_PRICE_NOT_FOUND'
  | 'BLOCKED'
  | 'ERROR';

export interface ScrapeResult {
  fsn: string;
  sku: string;
  sellerName: string | null;
  /**
   * The seller holding the buy box — the offer the product page headlines.
   * Optional so journals written before this field existed still parse.
   */
  buyboxSellerName?: string | null;
  mainPrice: number | null;
  sellerPrice: number | null;
  /** sellerPrice - mainPrice. Null when either side is missing. */
  difference: number | null;
  isPriceDifferent: boolean;
  productUrl: string;

  /** Diagnostics — safe to ignore, useful when a run misbehaves. */
  status: ScrapeStatus;
  message?: string;
  sellersScanned?: number;
  showMoreClicks?: number;
  /** Where the seller list came from. `api` is the fast path; the rest are browser. */
  source?: 'api' | 'network' | 'dom';
  durationMs?: number;
  /** How many times this product was attempted, including back-off retries. 1 when it worked first go. */
  attempts?: number;
  /** Path to the failure screenshot, when one was captured. */
  screenshotPath?: string;
}

/** Coarse stages of one product's scrape, for live progress reporting. */
export type ScrapeStep =
  | 'opening'
  | 'reading-page'
  | 'main-price'
  | 'opening-sellers'
  | 'finding-seller'
  | 'comparing'
  | 'done';

/** Called as a product moves through the pipeline. Purely informational. */
export type StepReporter = (step: ScrapeStep, input: ScrapeInput) => void;

/** A seller row as read off the page (or a network payload). */
export interface SellerCard {
  name: string;
  price: number | null;
  mrp?: number | null;
  rawPriceText?: string;
}

export interface ScraperOptions {
  headless?: boolean;
  /** Default per-action timeout (ms). */
  timeout?: number;
  /** Overall navigation timeout (ms). */
  navigationTimeout?: number;
  /**
   * Hard cap on "Show more" clicks. This is a runaway guard only — the loop
   * normally stops when the seller is found or the button disappears.
   */
  maxShowMoreClicks?: number;
  /** Try to reuse a captured seller API/network payload before DOM scraping. */
  useNetworkCapture?: boolean;

  /**
   * Call Flipkart's own seller endpoint directly instead of driving a browser.
   *
   * Roughly 60x faster — no page loads, and every seller arrives in one
   * response. A product the API cannot answer for still falls back to the full
   * browser path, so this changes how a result is obtained, never whether one
   * is. Set false to force the browser path for every product.
   */
  useFastApi?: boolean;
  /**
   * Products in flight at once on the fast path. The browser path is always
   * sequential and ignores this.
   */
  concurrency?: number;
  /**
   * Minimum milliseconds between requests to Flipkart, across all workers.
   *
   * This — not `concurrency` — is what keeps a run under the rate limit.
   * Measured on a 202-product batch: 8 workers unpaced drew 87 rejections; 8
   * workers spaced 100ms apart drew none. The limiter widens this by itself if
   * Flipkart does push back, then walks it back down as calls succeed.
   */
  requestGapMs?: number;
  /** Skip clicking and navigate straight to /sellers?pid=... when we can. */
  preferDirectSellerNavigation?: boolean;
  /** Emit progress logs. */
  verbose?: boolean;
  /** Playwright storageState path, for a logged-in session if you need one. */
  storageStatePath?: string;
  userAgent?: string;
  /** Screenshot destination on failure. */
  screenshotOnFailureDir?: string;

  /**
   * Pause between products, in ms. Zero (the default) preserves the old
   * back-to-back behaviour; anything above ~1000 is strongly advised for
   * batches in the hundreds, where 1000 rapid hits from one IP is what
   * actually trips Flipkart's bot wall.
   */
  delayMs?: number;
  /** Random 0..n ms added to each `delayMs` pause, so the cadence isn't robotic. */
  delayJitterMs?: number;
  /** First back-off pause after a BLOCKED product. Doubles per consecutive block. */
  blockBackoffMs?: number;
  /** How many times to back off and retry one product before giving up on the run. */
  blockRetries?: number;

  /**
   * Between products in a batch, spend ~0.5–3s doing idle human things on the
   * finished page — small curved mouse moves, a short scroll, a hover — before
   * the next product opens. Purely decorative: it runs after the result has
   * been computed, changes no page state, and cannot affect extracted data.
   * Defaults to on; set false to go straight from one product to the next.
   */
  humanLikeBehavior?: boolean;

  /**
   * Cancels a batch. Checked between products, and — because a product can sit
   * inside a 20s Playwright wait — also wired to close the active browser
   * context, so aborting takes effect immediately rather than at the next
   * product boundary. The aborted product is left unreported so a later resume
   * picks it up untouched.
   */
  signal?: AbortSignal;

  /** Fires as each product moves through the pipeline. Drives the live progress panel. */
  onStep?: StepReporter;
}

/** Called after each product in a batch, before the next one starts. */
export type ResultSink = (result: ScrapeResult, index: number) => void | Promise<void>;

export interface ResolvedOptions
  extends Required<
    Omit<ScraperOptions, 'storageStatePath' | 'screenshotOnFailureDir' | 'userAgent' | 'signal' | 'onStep'>
  > {
  storageStatePath?: string;
  screenshotOnFailureDir?: string;
  userAgent?: string;
  signal?: AbortSignal;
  onStep?: StepReporter;
}
