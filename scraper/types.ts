/**
 * Shared types for the Flipkart seller-price scraper.
 */

export interface ScrapeInput {
  productUrl: string;
  targetSeller: string;
  sku: string;
  fsn: string;
}

export type ScrapeStatus =
  | 'OK'
  | 'PRODUCT_UNAVAILABLE'
  | 'NO_SELLER_LINK'
  | 'SELLER_LIST_LOAD_FAILED'
  | 'SELLER_NOT_FOUND'
  | 'MAIN_PRICE_NOT_FOUND'
  | 'SELLER_PRICE_NOT_FOUND'
  | 'ERROR';

export interface ScrapeResult {
  fsn: string;
  sku: string;
  sellerName: string | null;
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
  /** Where the seller list came from. */
  source?: 'network' | 'dom';
  durationMs?: number;
}

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
  /** Skip clicking and navigate straight to /sellers?pid=... when we can. */
  preferDirectSellerNavigation?: boolean;
  /** Emit progress logs. */
  verbose?: boolean;
  /** Playwright storageState path, for a logged-in session if you need one. */
  storageStatePath?: string;
  userAgent?: string;
  /** Screenshot destination on failure. */
  screenshotOnFailureDir?: string;
}

export interface ResolvedOptions extends Required<Omit<ScraperOptions, 'storageStatePath' | 'screenshotOnFailureDir' | 'userAgent'>> {
  storageStatePath?: string;
  screenshotOnFailureDir?: string;
  userAgent?: string;
}
