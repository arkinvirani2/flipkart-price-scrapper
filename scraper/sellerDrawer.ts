/**
 * The "See other sellers" list: open it, enumerate sellers, page through
 * "show more" until the target turns up, and read its price.
 *
 * Two capture paths run here:
 *   - network: opportunistically reuse any JSON payload that already carries
 *     seller records, avoiding the click loop entirely;
 *   - dom: scrape the rendered cards, which is the reliable fallback.
 */

import type { Locator, Page, Response } from 'playwright';
import {
  DOM_EXTRACTION_SELECTORS,
  SELLER_API_URL_HINTS,
  SHOW_MORE,
  SHOW_MORE_TEXT,
  anyOf,
  type DomExtractionSelectors,
} from './selectors';
import { extractSellersFromJson, findSeller, parsePrice, sellerNamesMatch } from './parser';
import type { ResolvedOptions, SellerCard } from './types';
import { ScrapeError, dismissOverlays, log, waitFor, waitForPageSettled, withRetry } from './utils';
import type { SellerListEntry } from './productPage';

/* ----------------------------------------------------------- network capture */

export interface NetworkCapture {
  payloads: unknown[];
  detach: () => void;
}

/**
 * Record JSON responses that plausibly carry seller data.
 *
 * Flipkart has no documented seller API and the saved page snapshots contain no
 * server-rendered seller JSON, so this cannot be assumed to fire. It is a pure
 * accelerator: when it yields sellers we skip the entire click loop, and when it
 * yields nothing we DOM-scrape exactly as before.
 */
export function attachNetworkCapture(page: Page): NetworkCapture {
  const payloads: unknown[] = [];

  const onResponse = (response: Response): void => {
    const url = response.url();
    if (!SELLER_API_URL_HINTS.some((hint) => url.includes(hint))) return;

    const contentType = response.headers()['content-type'] ?? '';
    if (!contentType.includes('json')) return;

    // Fire-and-forget: never let body reading block or reject the page.
    void response
      .json()
      .then((body) => payloads.push(body))
      .catch(() => undefined);
  };

  page.on('response', onResponse);
  return { payloads, detach: () => page.off('response', onResponse) };
}

/** Pull seller records out of anything the sniffer collected. */
export function sellersFromNetwork(capture: NetworkCapture): SellerCard[] {
  const merged = new Map<string, SellerCard>();
  for (const payload of capture.payloads) {
    for (const seller of extractSellersFromJson(payload)) {
      const key = seller.name.toLowerCase();
      if (!merged.has(key)) merged.set(key, seller);
    }
  }
  return [...merged.values()];
}

/* -------------------------------------------------------- openSellerDrawer */

/**
 * Open the seller list.
 *
 * The control is a real anchor (`/sellers?pid=<FSN>`), so the default path is a
 * direct navigation — no click to be intercepted by a login interstitial, no
 * animation to wait out. Clicking is kept as the fallback for layouts where the
 * list opens as an in-page drawer instead.
 */
export async function openSellerDrawer(
  page: Page,
  entry: SellerListEntry,
  options: ResolvedOptions,
): Promise<void> {
  log.step('Opening seller drawer...');

  if (!entry.link && !entry.url) {
    throw new ScrapeError('NO_SELLER_LINK', 'No "See other sellers" control and no seller URL could be derived.');
  }

  const navigateDirect = async (): Promise<boolean> => {
    if (!entry.url) return false;
    log.info(`navigating directly to ${entry.url}`);
    await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: options.navigationTimeout });
    await waitForPageSettled(page, options.navigationTimeout);
    await dismissOverlays(page);
    return (await waitForSellerList(page, options)) > 0;
  };

  const clickThrough = async (): Promise<boolean> => {
    if (!entry.link) return false;
    log.info('clicking "See other sellers"');
    await entry.link.scrollIntoViewIfNeeded().catch(() => undefined);
    await entry.link.click({ timeout: options.timeout });
    await waitForPageSettled(page, options.navigationTimeout);
    await dismissOverlays(page);
    return (await waitForSellerList(page, options)) > 0;
  };

  const [first, second] = options.preferDirectSellerNavigation
    ? [navigateDirect, clickThrough]
    : [clickThrough, navigateDirect];

  const opened = await withRetry(
    async () => (await first()) || (await second()),
    { attempts: 2, description: 'opening seller list' },
  );

  if (!opened) {
    throw new ScrapeError('SELLER_LIST_LOAD_FAILED', 'Seller list did not render any seller cards.');
  }
}

/**
 * Block until at least one seller card exists. Returns how many rendered, or 0
 * on timeout. This is what makes the drawer "fully rendered" check real rather
 * than a guessed sleep — spinners simply keep the count at zero until content
 * lands.
 */
export async function waitForSellerList(page: Page, options: ResolvedOptions): Promise<number> {
  const count = await waitFor(
    async () => {
      const sellers = await extractSellers(page);
      return sellers.length > 0 ? sellers.length : null;
    },
    { timeoutMs: options.timeout, description: 'seller cards' },
  );
  return count ?? 0;
}

/* ------------------------------------------------------------ DOM extraction */

/**
 * Read every rendered seller card.
 *
 * Runs entirely in the page so one round-trip returns the whole list, and so we
 * can consult `getComputedStyle` — that is how the struck-through MRP gets told
 * apart from the selling price when a card shows several amounts.
 */
export async function extractSellers(page: Page): Promise<SellerCard[]> {
  return page.evaluate((selectors: DomExtractionSelectors) => {
    const priceRe = new RegExp(selectors.pricePattern);
    const priceReGlobal = new RegExp(selectors.pricePattern, 'g');

    const clean = (value: string | null | undefined): string =>
      (value ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

    const toNumber = (text: string): number | null => {
      const match = priceRe.exec(text);
      if (!match) return null;
      const value = Number(match[1].replace(/,/g, ''));
      return Number.isFinite(value) ? value : null;
    };

    const isStruckThrough = (element: Element): boolean => {
      const style = window.getComputedStyle(element as HTMLElement);
      const decoration = `${style.textDecorationLine} ${style.textDecoration}`;
      return decoration.includes('line-through');
    };

    const queryAll = (root: ParentNode, list: string[]): Element[] => {
      for (const selector of list) {
        const found = Array.from(root.querySelectorAll(selector));
        if (found.length > 0) return found;
      }
      return [];
    };

    /**
     * First price in document order — NOT the lowest.
     *
     * Every card renders price before MRP before bank offers, and the desktop
     * layout puts "Flat ₹50 off" copy inside the card. Lowest-wins would report
     * that ₹50 as the seller's price.
     */
    const firstPriceIn = (text: string): number | null => {
      for (const match of text.matchAll(priceReGlobal)) {
        const value = Number(match[1].replace(/,/g, ''));
        if (Number.isFinite(value)) return value;
      }
      return null;
    };

    const cards = queryAll(document, selectors.card);
    const results: Array<{ name: string; price: number | null; mrp: number | null; rawPriceText: string }> = [];

    for (const card of cards) {
      // The name node is rendered twice per card (responsive duplicate), so the
      // first match is the canonical one.
      const nameEl = queryAll(card, selectors.name)[0];
      const name = clean(nameEl?.textContent);
      if (!name) continue;

      const priceEls = queryAll(card, selectors.price);
      let price: number | null = null;
      for (const el of priceEls) {
        if (isStruckThrough(el)) continue;
        const value = toNumber(clean(el.textContent));
        if (value !== null) {
          price = value;
          break;
        }
      }

      const cardText = clean(card.textContent);
      // No structural price hit means the price classes rotated; fall back to
      // the first currency value inside this card.
      if (price === null) price = firstPriceIn(cardText);

      const mrpEl = queryAll(card, selectors.mrp)[0];
      const mrp = mrpEl ? toNumber(clean(mrpEl.textContent)) : null;

      results.push({ name, price, mrp, rawPriceText: cardText.slice(0, 200) });
    }

    return results;
  }, DOM_EXTRACTION_SELECTORS);
}

/**
 * Text-anchored lookup for one seller, used when the card classes have rotated
 * and `extractSellers` comes back empty or incomplete.
 *
 * Finds the element whose text is exactly the seller name, then walks up until
 * it reaches an ancestor that also contains a price — that ancestor is the card,
 * whatever it happens to be called this week.
 */
export async function findSellerByNameAnchored(page: Page, targetSeller: string): Promise<SellerCard | null> {
  const result = await page.evaluate(
    ({ target, pricePattern }: { target: string; pricePattern: string }) => {
      const priceReGlobal = new RegExp(pricePattern, 'g');
      const normalize = (value: string): string =>
        value.replace(/ /g, ' ').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      const wanted = normalize(target);
      if (!wanted) return null;

      const anchors = Array.from(document.querySelectorAll<HTMLElement>('div, span, p, a, li'))
        // Only leaf-ish nodes: an ancestor containing the whole page also
        // "contains" the name, and would match uselessly.
        .filter((el) => el.children.length === 0 && normalize(el.textContent ?? '') === wanted);

      for (const anchor of anchors) {
        let node: HTMLElement | null = anchor;
        for (let depth = 0; depth < 8 && node; depth++) {
          const text = (node.textContent ?? '').replace(/ /g, ' ');
          // First price in document order, NOT the lowest — the desktop card
          // carries "Flat ₹50 off" bank-offer copy beneath the real price.
          let price: number | null = null;
          for (const match of text.matchAll(priceReGlobal)) {
            const value = Number(match[1].replace(/,/g, ''));
            if (Number.isFinite(value)) {
              price = value;
              break;
            }
          }
          if (price !== null) {
            return {
              name: (anchor.textContent ?? '').trim(),
              price,
              rawPriceText: text.replace(/\s+/g, ' ').trim().slice(0, 200),
            };
          }
          node = node.parentElement;
        }
      }
      return null;
    },
    { target: targetSeller, pricePattern: DOM_EXTRACTION_SELECTORS.pricePattern },
  );

  return result ? { name: result.name, price: result.price, rawPriceText: result.rawPriceText } : null;
}

/* --------------------------------------------------------------- show more */

/** The paginator, matched by text — its class is shared with a tooltip button. */
export function showMoreButton(page: Page): Locator {
  return page.getByRole('button', { name: SHOW_MORE_TEXT }).last();
}

async function showMoreIsActionable(page: Page): Promise<boolean> {
  const byRole = showMoreButton(page);
  if ((await byRole.count()) > 0 && (await byRole.isVisible().catch(() => false))) {
    return byRole.isEnabled().catch(() => false);
  }
  const byText = page.locator(anyOf(SHOW_MORE)).filter({ hasText: SHOW_MORE_TEXT }).last();
  return (await byText.count()) > 0 && (await byText.isVisible().catch(() => false));
}

export interface SellerSearchResult {
  seller: SellerCard | null;
  /** Every card seen, in page order — the buy-box winner is inferred from these. */
  sellers: SellerCard[];
  sellersScanned: number;
  showMoreClicks: number;
}

/**
 * Page through the seller list until the target appears or there is nothing
 * left to load.
 *
 * The loop is driven by state, never by a click count: it stops when the seller
 * is found, when "show more" is gone, or when a click stops producing new rows.
 * `maxShowMoreClicks` is only a runaway guard.
 */
export async function clickShowMoreUntilSellerFound(
  page: Page,
  targetSeller: string,
  options: ResolvedOptions,
): Promise<SellerSearchResult> {
  let showMoreClicks = 0;
  let sellers = await extractSellers(page);
  let lastCount = sellers.length;

  for (;;) {
    const structuralMatch = findSeller(sellers, targetSeller);
    if (structuralMatch) {
      log.step('Seller found...');
      return { seller: structuralMatch, sellers, sellersScanned: sellers.length, showMoreClicks };
    }

    // Catches the case where the card classes changed and structured extraction
    // silently under-reports, but the name is plainly on the page.
    const anchored = await findSellerByNameAnchored(page, targetSeller);
    if (anchored && sellerNamesMatch(anchored.name, targetSeller)) {
      log.step('Seller found...');
      log.warn('matched via text anchor — card selectors may need updating');
      return { seller: anchored, sellers, sellersScanned: Math.max(sellers.length, 1), showMoreClicks };
    }

    log.step(`Seller not found... (${sellers.length} sellers scanned)`);

    if (!(await showMoreIsActionable(page))) {
      log.info('no "Show More" control remains — seller list is exhausted');
      return { seller: null, sellers, sellersScanned: sellers.length, showMoreClicks };
    }

    if (showMoreClicks >= options.maxShowMoreClicks) {
      log.warn(`stopping at the ${options.maxShowMoreClicks}-click safety cap with "Show More" still present`);
      return { seller: null, sellers, sellersScanned: sellers.length, showMoreClicks };
    }

    log.step('Clicking Show More...');
    await withRetry(
      async () => {
        const button = showMoreButton(page);
        await button.scrollIntoViewIfNeeded().catch(() => undefined);
        await button.click({ timeout: options.timeout });
      },
      { attempts: 2, description: '"Show More" click' },
    );
    showMoreClicks++;

    // Wait on the list actually growing — this is the lazy-load / spinner wait.
    const grown = await waitFor(
      async () => {
        const current = await extractSellers(page);
        return current.length > lastCount ? current : null;
      },
      { timeoutMs: options.timeout, description: 'additional sellers' },
    );

    if (!grown) {
      log.info('no new sellers rendered after "Show More" — treating the list as complete');
      const finalSellers = await extractSellers(page);
      const lateMatch = findSeller(finalSellers, targetSeller);
      return { seller: lateMatch, sellers: finalSellers, sellersScanned: finalSellers.length, showMoreClicks };
    }

    sellers = grown;
    lastCount = grown.length;
  }
}

/* ---------------------------------------------------------- getSellerPrice */

/**
 * Resolve the target seller's price, preferring a captured network payload and
 * falling back to the DOM click-through.
 */
export async function getSellerPrice(
  page: Page,
  targetSeller: string,
  capture: NetworkCapture | null,
  options: ResolvedOptions,
): Promise<{
  seller: SellerCard | null;
  /** Every card the winning path saw. Page-ordered for `dom`, arbitrary for `network`. */
  sellers: SellerCard[];
  source: 'network' | 'dom';
  sellersScanned: number;
  showMoreClicks: number;
}> {
  if (capture && options.useNetworkCapture) {
    const networkSellers = sellersFromNetwork(capture);
    const match = findSeller(networkSellers, targetSeller);
    if (match && match.price !== null) {
      log.info(`seller resolved from a captured network payload (${networkSellers.length} sellers)`);
      return {
        seller: match,
        sellers: networkSellers,
        source: 'network',
        sellersScanned: networkSellers.length,
        showMoreClicks: 0,
      };
    }
    if (networkSellers.length > 0) {
      log.info(`network payload had ${networkSellers.length} sellers but not the target — falling back to DOM`);
    }
  }

  const result = await clickShowMoreUntilSellerFound(page, targetSeller, options);
  return {
    seller: result.seller,
    sellers: result.sellers,
    source: 'dom',
    sellersScanned: result.sellersScanned,
    showMoreClicks: result.showMoreClicks,
  };
}

/** Re-read a price string through the shared parser. Exported for tests. */
export function normalizeSellerPrice(raw: string | null): number | null {
  return parsePrice(raw);
}
