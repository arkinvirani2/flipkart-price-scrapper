/**
 * SINGLE SOURCE OF TRUTH FOR EVERY FLIPKART SELECTOR.
 *
 * When Flipkart ships a DOM change, this file should be the only one you edit.
 *
 * Ordering convention: every entry is a *list* tried in order, cheapest and
 * most stable first. Stability tiers we rely on, best to worst:
 *
 *   1. Structured data   -> script#jsonLD (schema.org Product/Offer). Survives
 *                           every CSS refactor. This is our primary price source.
 *   2. Text / role       -> getByRole('button', { name: /show more/i }). Survives
 *                           class-hash churn; only breaks on copy changes.
 *   3. href shape        -> a[href*="/sellers?pid="]. Stable URL contract.
 *   4. Hashed classes    -> .eXlcRr, .b1jAQQ, .XVCSsK. Captured 2026-07 from the
 *                           saved snapshots. Assume these rot; they are fallbacks
 *                           and the code degrades to text-anchored search without
 *                           them.
 *
 * Verified against:
 *   product-detailpage.html            (PDP, pid=KMTHGNNHMYWQHJN7)
 *   after-click-see-more-seller.html   (/sellers page, 10 cards + "show more")
 */

/** schema.org JSON-LD blob on the product page. Carries name, sku and offers.price. */
export const JSON_LD = [
  'script#jsonLD',
  'script[type="application/ld+json"]',
] as const;

/** Link into the seller list. Its href gives us `/sellers?pid=<FSN>`. */
export const SEE_OTHER_SELLERS = [
  'a[href*="/sellers?pid="]',
  'a[href^="/sellers"]',
] as const;

/** Text used to find the seller link when the href shape changes. */
export const SEE_OTHER_SELLERS_TEXT = /see\s+other\s+sellers?/i;

/**
 * Main selling price on the PDP, DOM fallback only — prefer JSON_LD.
 * These classes are atomic/generated and WILL churn; the parser also runs a
 * currency-regex sweep as a last resort, so a miss here is not fatal.
 */
export const MAIN_PRICE = [
  'div[class*="Nx9bqj"]',
  'div[class*="_30jeq3"]',
] as const;

/**
 * Wrapper around one seller row on the /sellers page.
 *
 * Flipkart serves two quite different seller layouts and we must handle both:
 *   compact  (after-click-see-more-seller.html) - .eXlcRr, paginated by "show more"
 *   desktop  (all-sellers.html)                 - .QGdlvi, every seller in one shot
 *
 * The extractor takes the first selector in this list that matches anything, so
 * the two layouts never collide - compact selectors simply find nothing on a
 * desktop page and vice versa.
 */
export const SELLER_CARD = [
  'div.eXlcRr',
  'div.QGdlvi',
  'div[class*="eXlcRr"]',
  'div[class*="QGdlvi"]',
] as const;

/**
 * Seller name inside a card.
 *
 * Compact layout renders this element TWICE per card (responsive duplicate) —
 * 20 nodes for 10 sellers — so always take the first match within a card.
 * Desktop wraps the name in a span: <div class="zCSLD9"><span>TREVIAA</span></div>.
 */
export const SELLER_NAME = [
  'div.b1jAQQ',
  'div.zCSLD9',
  'div[class*="b1jAQQ"]',
  'div[class*="zCSLD9"]',
  '#sellerName span span',
] as const;

/** Selling price inside a seller card. */
export const SELLER_PRICE = [
  'span.XVCSsK',
  'div.hZ3P6w',
  'span[class*="XVCSsK"]',
  'div[class*="hZ3P6w"]',
] as const;

/** Struck-through MRP inside a seller card. */
export const SELLER_MRP = [
  'span.RdHagW',
  'div.kRYCnD',
  'span[class*="RdHagW"]',
  'div[class*="kRYCnD"]',
] as const;

/**
 * Paginator at the bottom of the seller list. Rendered lowercase ("show more")
 * and its class (.xqOMQN) is shared with an unrelated "Got it" tooltip button —
 * so this MUST be matched by text, never by class alone.
 */
export const SHOW_MORE_TEXT = /^\s*show\s*more\s*$/i;
export const SHOW_MORE = [
  'button',
  '[role="button"]',
] as const;

/** Dismissable login interstitial that can swallow the first click. */
export const LOGIN_MODAL_CLOSE = [
  'button._2KpZ6l._2doB4z',
  'button[class*="_2doB4z"]',
  'span[role="button"]:has-text("✕")',
] as const;

/** Out-of-stock / unavailable markers. */
export const UNAVAILABLE_TEXT =
  /(currently unavailable|sold out|out of stock|this item is not available)/i;

/**
 * Rate-limit / bot-wall markers. Distinct from UNAVAILABLE_TEXT: these mean
 * "back off", not "this product is dead", and the caller must pause rather than
 * burn through the rest of the batch.
 */
export const BLOCKED_TEXT =
  /(captcha|unusual traffic|are you a human|verify you are|too many requests|access denied|request blocked|retry after)/i;

/** HTTP statuses that mean the same thing as BLOCKED_TEXT. */
export const BLOCKED_STATUSES = [403, 429, 503] as const;

/**
 * Matches "₹1,234", "Rs. 1234", "INR 1234.50". Capture group 1 is the raw number.
 * Kept here so DOM-side and network-side parsing agree on one definition.
 */
export const PRICE_PATTERN_SOURCE = '(?:₹|Rs\\.?|INR)\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)';

/**
 * URL fragments that plausibly carry seller/listing data as JSON. Used by the
 * opportunistic network sniffer. A miss here just means we DOM-scrape.
 */
export const SELLER_API_URL_HINTS = [
  '/api/',
  'sellers',
  'listing',
  'multiwidget',
  'page/fetch',
] as const;

/** JSON keys that identify a seller record inside an arbitrary payload. */
export const SELLER_JSON_NAME_KEYS = ['sellerName', 'sellerDisplayName', 'name', 'title'] as const;
export const SELLER_JSON_PRICE_KEYS = ['finalPrice', 'sellingPrice', 'price', 'value', 'decimalValue'] as const;

/** Everything the browser-side extractor needs, in one serializable bag. */
export const DOM_EXTRACTION_SELECTORS = {
  card: SELLER_CARD as unknown as string[],
  name: SELLER_NAME as unknown as string[],
  price: SELLER_PRICE as unknown as string[],
  mrp: SELLER_MRP as unknown as string[],
  pricePattern: PRICE_PATTERN_SOURCE,
};

export type DomExtractionSelectors = typeof DOM_EXTRACTION_SELECTORS;

/** Build the canonical seller-list URL for a product id (FSN). */
export function sellersUrlForPid(pid: string): string {
  return `https://www.flipkart.com/sellers?pid=${encodeURIComponent(pid)}`;
}

/** Join a selector list into one CSS query. */
export function anyOf(list: readonly string[]): string {
  return list.join(', ');
}
