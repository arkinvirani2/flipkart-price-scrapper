/**
 * Product detail page: open it, confirm it's purchasable, read the headline
 * price, and find the way into the seller list.
 */

import type { Locator, Page } from 'playwright';
import {
  JSON_LD,
  MAIN_PRICE,
  PRICE_PATTERN_SOURCE,
  SEE_OTHER_SELLERS,
  SEE_OTHER_SELLERS_TEXT,
  UNAVAILABLE_TEXT,
  anyOf,
  sellersUrlForPid,
} from './selectors';
import { parsePrice, parseProductJsonLd, type ProductJsonLd } from './parser';
import {
  ScrapeError,
  dismissOverlays,
  log,
  pidFromUrl,
  waitFor,
  waitForPageSettled,
  withRetry,
} from './utils';
import type { ResolvedOptions } from './types';

/* --------------------------------------------------------------- openProduct */

/**
 * Navigate to the product URL and wait until it is actually usable — meaning
 * either the JSON-LD blob or a rendered price is present, not merely that the
 * `load` event fired. Flipkart hydrates the price widget after load.
 */
export async function openProduct(page: Page, productUrl: string, options: ResolvedOptions): Promise<void> {
  log.step('Opening product...');

  await withRetry(
    async () => {
      await page.goto(productUrl, {
        waitUntil: 'domcontentloaded',
        timeout: options.navigationTimeout,
      });
    },
    { attempts: 3, description: 'product navigation' },
  );

  await waitForPageSettled(page, options.navigationTimeout);
  await dismissOverlays(page);

  const ready = await waitFor(
    async () => {
      const hasJsonLd = (await page.locator(anyOf(JSON_LD)).count()) > 0;
      if (hasJsonLd) return true;
      const priceRe = new RegExp(PRICE_PATTERN_SOURCE);
      const body = await page.locator('body').innerText().catch(() => '');
      return priceRe.test(body);
    },
    { timeoutMs: options.timeout, description: 'product content' },
  );

  if (!ready) {
    throw new ScrapeError('MAIN_PRICE_NOT_FOUND', 'Product page rendered no price or structured data.');
  }
}

/* ------------------------------------------------------------- availability */

/** Returns a reason string when the product cannot be bought, else null. */
export async function checkAvailability(page: Page, jsonLd: ProductJsonLd | null): Promise<string | null> {
  if (jsonLd?.availability && /OutOfStock|SoldOut|Discontinued/i.test(jsonLd.availability)) {
    return `Structured data reports availability=${jsonLd.availability}`;
  }

  const body = await page.locator('body').innerText().catch(() => '');
  const match = UNAVAILABLE_TEXT.exec(body);
  return match ? `Page shows "${match[0]}"` : null;
}

/* ------------------------------------------------------------------ JSON-LD */

/** Read and parse the product's schema.org blob. Null when absent or malformed. */
export async function readProductJsonLd(page: Page): Promise<ProductJsonLd | null> {
  const scripts = page.locator(anyOf(JSON_LD));
  const count = await scripts.count();

  for (let i = 0; i < count; i++) {
    const raw = await scripts.nth(i).textContent().catch(() => null);
    if (!raw) continue;
    const parsed = parseProductJsonLd(raw);
    if (parsed) return parsed;
  }
  return null;
}

/* ------------------------------------------------------------- getMainPrice */

/**
 * Extract the current selling price shown on the product page.
 *
 * Three tiers, cheapest and most durable first:
 *   1. JSON-LD offers.price  — immune to CSS churn, exact.
 *   2. Known price classes   — fast, but the classes are generated hashes.
 *   3. Currency-regex sweep  — scans visible text near the top of the page.
 */
export async function getMainPrice(
  page: Page,
  jsonLd: ProductJsonLd | null,
  options: ResolvedOptions,
): Promise<number | null> {
  log.step('Reading main price...');

  if (jsonLd?.price != null) {
    log.info(`main price from structured data: ₹${jsonLd.price}`);
    return jsonLd.price;
  }

  const domPrice = await waitFor(
    async () => {
      const nodes = page.locator(anyOf(MAIN_PRICE));
      const count = await nodes.count();
      for (let i = 0; i < count; i++) {
        const price = parsePrice(await nodes.nth(i).textContent());
        if (price !== null) return price;
      }
      return null;
    },
    { timeoutMs: Math.min(options.timeout, 8_000), description: 'main price element' },
  );

  if (domPrice !== null) {
    log.info(`main price from DOM: ₹${domPrice}`);
    return domPrice;
  }

  const anchored = await priceAnchoredToTitle(page);
  if (anchored !== null) {
    log.warn(`main price recovered by title anchor: ₹${anchored} (selectors may need updating)`);
    return anchored;
  }

  return null;
}

/**
 * Last-resort price recovery, anchored to the product title.
 *
 * Deliberately NOT a whole-page sweep. The PDP opens with a sponsored carousel,
 * so the first currency value in the document is an *advert's* price — on the
 * captured page that is ₹265 against a true price of ₹236. Returning that would
 * silently corrupt every comparison, which is worse than returning nothing.
 *
 * The <h1> product title reliably precedes the buy-box, so the first currency
 * value following it in document order is the headline price. Values without a
 * currency symbol (the struck-through MRP renders as a bare "499") are skipped
 * by construction, since the pattern requires ₹/Rs/INR.
 */
async function priceAnchoredToTitle(page: Page): Promise<number | null> {
  const raw = await page
    .evaluate((pattern: string) => {
      const title = document.querySelector('h1');
      if (!title) return null;

      const priceRe = new RegExp(pattern);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let reachedTitle = false;

      while (walker.nextNode()) {
        const el = walker.currentNode as HTMLElement;
        if (!reachedTitle) {
          if (el === title || title.contains(el)) reachedTitle = true;
          continue;
        }
        // Leaf elements only: an ancestor's textContent concatenates the whole
        // buy-box and would match the wrong number.
        if (el.children.length > 0) continue;

        const text = (el.textContent ?? '').replace(/ /g, ' ').trim();
        if (!priceRe.test(text)) continue;

        const style = window.getComputedStyle(el);
        const decoration = `${style.textDecorationLine} ${style.textDecoration}`;
        if (decoration.includes('line-through')) continue;

        return text;
      }
      return null;
    }, PRICE_PATTERN_SOURCE)
    .catch(() => null);

  return parsePrice(raw);
}

/* --------------------------------------------------- seller list entry point */

export interface SellerListEntry {
  /** Locator for the "See other sellers" control, when one is on the page. */
  link: Locator | null;
  /** Absolute /sellers?pid=... URL, when we could derive one. */
  url: string | null;
}

/**
 * Locate the route into the seller list.
 *
 * On the captured PDP this control is a plain anchor:
 *   <a href="/sellers?pid=KMTHGNNHMYWQHJN7">See other sellers</a>
 *
 * Because it is a real link, we can skip the click entirely and navigate — that
 * is both faster and immune to overlays intercepting the click. We still return
 * the locator so the caller can click when it prefers to.
 */
export async function findSellerListEntry(
  page: Page,
  jsonLd: ProductJsonLd | null,
  productUrl: string,
): Promise<SellerListEntry> {
  const byHref = page.locator(anyOf(SEE_OTHER_SELLERS)).first();
  if ((await byHref.count()) > 0) {
    const href = await byHref.getAttribute('href');
    return { link: byHref, url: href ? new URL(href, page.url()).toString() : null };
  }

  const byText = page.getByText(SEE_OTHER_SELLERS_TEXT).first();
  if ((await byText.count()) > 0) {
    return { link: byText, url: null };
  }

  // No control on the page — but the seller list is addressable by product id,
  // which we can get from structured data or the URL itself.
  const pid = jsonLd?.sku ?? pidFromUrl(productUrl) ?? pidFromUrl(page.url());
  return { link: null, url: pid ? sellersUrlForPid(pid) : null };
}
