/**
 * The fast path: Flipkart's own seller-list endpoint, called directly over HTTP.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The browser path loads two full pages per product (the PDP, then
 * /sellers?pid=…) and reads prices out of rendered DOM. Profiling a real
 * 202-product batch put that at ~7.4s per product wall-clock — 1.9s to load the
 * PDP, 1.5s to load and scrape the seller page, and ~4s of deliberate idle
 * (pacing delay, human-like behaviour, context churn).
 *
 * But /sellers?pid=… is not server-rendered at all: it ships an empty shell and
 * fills itself from one POST to `product-sellers`. That single call returns
 * every seller for a product — names and prices as numbers, no pagination, no
 * "show more" — plus the buy-box winner and the page price. It needs no
 * cookies, no session and no browser.
 *
 * Same batch, same products, through this path: 24 seconds instead of 25
 * minutes, with identical seller prices on all 202.
 *
 * ── What this module promises ───────────────────────────────────────────────
 * It is a *parser and a pacer*, not a policy. It throws `ScrapeError` for
 * classified outcomes the caller should record (BLOCKED, PRODUCT_UNAVAILABLE)
 * and a plain `Error` for anything that means "this call did not work" — which
 * is the caller's cue to fall back to the browser rather than to fail the row.
 */

import {
  API_WIDGET_ADD_TO_CART,
  API_WIDGET_NOTIFY,
  API_WIDGET_SELLERS,
  API_WIDGET_SUMMARY,
  SELLER_API_UA_SUFFIX,
  SELLER_API_URL,
  sellerApiBody,
} from './selectors';
import type { SellerCard } from './types';
import { ScrapeError, delay, errorMessage, log } from './utils';

/* ------------------------------------------------------------------- types */

export interface ApiProduct {
  /** The price the product page headlines — the buy-box offer. */
  mainPrice: number | null;
  /** Every seller for this product, in the order Flipkart returned them. */
  sellers: SellerCard[];
  /** The seller holding the buy box, per Flipkart's own `selected` flag. */
  buyboxSellerName: string | null;
  /** Set when the product cannot currently be bought at all. */
  unavailableReason: string | null;
}

export interface ApiOptions {
  /** Milliseconds between request starts, enforced across all callers. */
  requestGapMs: number;
  /** How many times to retry one product through 429s / 5xx before giving up. */
  retries: number;
  /** First pause after a 429. Doubles per consecutive retry. */
  backoffMs: number;
  /** Per-request timeout. */
  timeoutMs: number;
  userAgent: string;
  signal?: AbortSignal;
}

/* ------------------------------------------------------------ rate limiter */

/**
 * A single global pacer for every call to Flipkart.
 *
 * Concurrency alone is not the thing Flipkart objects to — *burst rate* is.
 * Measured on a real batch: 8 workers with no pacing produced 87 rejections in
 * 202 requests, while 8 workers spaced 100ms apart produced none. So the pool
 * size and the request rate are deliberately separate knobs, and this class
 * owns the one that matters.
 *
 * `penalise()` widens the gap when Flipkart does push back and `relax()` walks
 * it back down as calls succeed, so a run that meets a temporary limit slows
 * down and then recovers instead of either dying or hammering.
 */
export class RateLimiter {
  private nextSlot = 0;
  private penaltyMs = 0;

  constructor(private readonly baseGapMs: number) {}

  /** Resolves when this caller is allowed to start its request. */
  async acquire(signal?: AbortSignal): Promise<void> {
    const gap = this.baseGapMs + this.penaltyMs;
    const now = Date.now();
    // Claim the slot before awaiting, so concurrent callers queue behind each
    // other rather than all reading the same `now` and firing together.
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + gap;
    if (slot > now) await delay(slot - now, signal);
  }

  /** Flipkart pushed back — widen the gap, up to a ceiling. */
  penalise(): void {
    this.penaltyMs = Math.min(2_000, this.penaltyMs === 0 ? 250 : this.penaltyMs * 2);
    log.warn(`rate limited — widening the request gap to ${this.baseGapMs + this.penaltyMs}ms`);
  }

  /** A call succeeded — give a little of the penalty back. */
  relax(): void {
    if (this.penaltyMs > 0) this.penaltyMs = Math.max(0, this.penaltyMs - 25);
  }

  /** Current effective gap, for logging. */
  get gapMs(): number {
    return this.baseGapMs + this.penaltyMs;
  }
}

/* ------------------------------------------------------------------ fetching */

/** Worth another go — the call may simply have been unlucky. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Of those, the ones that actually mean "you are being rate limited".
 *
 * The distinction decides whether a run stops. A 429 is about our traffic, so
 * every product after it would fare no better and the batch should back off. A
 * 5xx is not: Flipkart answers an unknown product id with a 500, so treating
 * that as a wall would let one bad FSN halt a thousand-product batch. Persistent
 * 5xx therefore falls through to the browser, which classifies the product
 * properly instead of guessing.
 */
const RATE_LIMIT_STATUSES = new Set([429, 503]);

/**
 * Fetch one product's seller list, retrying through rate limits.
 *
 * Throws `ScrapeError('BLOCKED')` when Flipkart is still refusing after every
 * retry — the caller treats that exactly like a bot wall on the browser path.
 * Any other failure throws a plain Error, which means "fall back to the
 * browser", not "record a failure".
 */
export async function fetchProductSellers(
  pid: string,
  limiter: RateLimiter,
  options: ApiOptions,
): Promise<ApiProduct> {
  let lastStatus = 0;

  for (let attempt = 1; attempt <= options.retries + 1; attempt++) {
    if (options.signal?.aborted) throw new Error('aborted');
    await limiter.acquire(options.signal);
    if (options.signal?.aborted) throw new Error('aborted');

    let response: Response;
    try {
      response = await requestOnce(pid, options);
    } catch (error) {
      // A socket-level failure is worth one more go; a caller abort is not.
      if (options.signal?.aborted) throw new Error('aborted');
      if (attempt > options.retries) throw new Error(`seller API request failed: ${errorMessage(error)}`);
      await delay(options.backoffMs * 2 ** (attempt - 1), options.signal);
      continue;
    }

    if (response.ok) {
      limiter.relax();
      return parseSellerResponse(await response.json(), pid);
    }

    // Drain the body so the socket is reusable by the next request.
    await response.text().catch(() => undefined);
    lastStatus = response.status;

    if (!RETRYABLE_STATUSES.has(response.status)) {
      throw new Error(`seller API returned HTTP ${response.status}`);
    }

    if (RATE_LIMIT_STATUSES.has(response.status)) limiter.penalise();

    if (attempt > options.retries) break;

    // Honour Retry-After when Flipkart sends one; it knows better than we do.
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    const backoffMs = retryAfterMs ?? options.backoffMs * 2 ** (attempt - 1);
    log.warn(`seller API HTTP ${response.status} — retrying in ${Math.round(backoffMs / 1000)}s (${attempt}/${options.retries})`);
    await delay(backoffMs, options.signal);
  }

  if (RATE_LIMIT_STATUSES.has(lastStatus)) {
    throw new ScrapeError('BLOCKED', `Seller API kept returning HTTP ${lastStatus} after ${options.retries} retries.`);
  }
  throw new Error(`seller API kept returning HTTP ${lastStatus} after ${options.retries} retries`);
}

async function requestOnce(pid: string, options: ApiOptions): Promise<Response> {
  // Own controller per request: the caller's signal cancels the run, this one
  // enforces the per-request deadline, and either may fire first.
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    return await fetch(SELLER_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': options.userAgent,
        'x-user-agent': options.userAgent + SELLER_API_UA_SUFFIX,
        'accept-language': 'en-IN',
        origin: 'https://www.flipkart.com',
        referer: 'https://www.flipkart.com/',
      },
      body: sellerApiBody(pid),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** `Retry-After` is either seconds or an HTTP date. Null when absent or junk. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/* ------------------------------------------------------------------ parsing */

/**
 * Turn the widget soup into the same shape the DOM path produces.
 *
 * Widget keys carry an instance suffix (`product_seller_detail_1`), so every
 * lookup here is by prefix — a layout change that renumbers them must not
 * silently return "no sellers".
 */
export function parseSellerResponse(payload: unknown, pid: string): ApiProduct {
  const data = widgetBag(payload);
  if (!data) throw new Error(`seller API returned no widget data for ${pid}`);

  const sellersWidget = widgetByPrefix(data, API_WIDGET_SELLERS);
  const rows = (sellersWidget?.data ?? null) as Record<string, unknown> | null;
  if (!rows || typeof rows !== 'object') {
    throw new Error(`seller API returned no seller widget for ${pid}`);
  }

  const sellers: SellerCard[] = [];
  let buyboxSellerName: string | null = null;

  // Keys are stringified indices ("0".."30") and Object.keys does not order
  // those the way the page does, so sort numerically to preserve page order —
  // the buy-box fallback and every "first seller" read depend on it.
  for (const key of Object.keys(rows).sort((a, b) => Number(a) - Number(b))) {
    const value = asRecord(asRecord(rows[key])?.value);
    if (!value) continue;

    const name = str(asRecord(asRecord(value.sellerInfo)?.value)?.name);
    if (!name) continue;

    const pricing = asRecord(asRecord(value.pricing)?.value);
    const price = num(asRecord(pricing?.finalPrice)?.value);
    const mrp = num(
      (Array.isArray(pricing?.prices) ? pricing.prices : [])
        .map(asRecord)
        .find((entry) => entry?.priceType === 'MRP')?.value,
    );

    if (value.selected === true) buyboxSellerName = name;
    sellers.push({ name, price, mrp, rawPriceText: `api:${str(value.listingId) ?? ''}` });
  }

  const summary = asRecord(
    (widgetByPrefix(data, API_WIDGET_SUMMARY)?.data as unknown[] | undefined)?.[0],
  );
  const mainPrice = num(
    asRecord(asRecord(asRecord(summary?.value)?.pricing)?.finalPrice)?.value,
  );

  return {
    mainPrice,
    sellers,
    buyboxSellerName,
    unavailableReason: availabilityReason(data, sellers),
  };
}

/**
 * Decide whether the product is buyable.
 *
 * Flipkart does not send an availability field here; it sends *widgets*. A live
 * product gets Add-to-cart and Buy-now widgets and no notify widget. One that
 * cannot be bought gets the mirror image: a populated "Notify me" widget and
 * empty cart widgets. Both halves are required — a single empty widget is
 * ordinary for some categories, but the pair together is unambiguous.
 */
function availabilityReason(data: Record<string, unknown>, sellers: SellerCard[]): string | null {
  const notify = widgetByPrefix(data, API_WIDGET_NOTIFY);
  const cart = widgetByPrefix(data, API_WIDGET_ADD_TO_CART);

  const hasNotify = notify !== null && Object.keys(notify).length > 0;
  const hasCart = cart !== null && Object.keys(cart).length > 0;

  if (hasNotify && !hasCart) return 'Flipkart offers "Notify me" instead of "Add to cart" — the product is out of stock.';
  if (sellers.length === 0) return 'No seller currently lists this product.';
  return null;
}

/* --------------------------------------------------------------- accessors */

/** `RESPONSE.data`, the map of widget-key -> widget. Null when the shape moved. */
function widgetBag(payload: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(asRecord(payload)?.RESPONSE)?.data);
}

/** First widget whose key starts with `prefix`, unwrapped to its own record. */
function widgetByPrefix(data: Record<string, unknown>, prefix: string): Record<string, unknown> | null {
  const key = Object.keys(data).find((candidate) => candidate.startsWith(prefix));
  return key === undefined ? null : asRecord(data[key]);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
