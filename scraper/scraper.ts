/**
 * Orchestration: open the product, read both prices, compare, return a result.
 *
 * Every classified failure produces a result object with a `status` — the
 * function only throws on genuinely unexpected errors, and even then
 * `scrapeProduct` converts it into a result rather than exploding on the caller.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { humanBehavior } from './humanBehavior';
import { comparePrice, pickBuyboxSeller } from './parser';
import {
  checkAvailability,
  findSellerListEntry,
  getMainPrice,
  openProduct,
  readProductJsonLd,
} from './productPage';
import { attachNetworkCapture, getSellerPrice, openSellerDrawer, type NetworkCapture } from './sellerDrawer';
import type {
  ResolvedOptions,
  ResultSink,
  ScrapeInput,
  ScrapeResult,
  ScrapeStatus,
  ScraperOptions,
} from './types';
import { ScrapeError, errorMessage, jitteredDelay, log, resolveOptions, setVerbose } from './utils';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ------------------------------------------------------------ single product */

/**
 * Scrape one product and compare its headline price against `targetSeller`'s.
 *
 * Launches and disposes its own browser. To scrape many products, use
 * `scrapeProducts` so one browser is reused across them.
 */
export async function scrapeProduct(input: ScrapeInput, options: ScraperOptions = {}): Promise<ScrapeResult> {
  const resolved = resolveOptions(options);
  setVerbose(resolved.verbose);

  let browser: Browser | null = null;
  try {
    browser = await launchBrowser(resolved);
    const context = await createContext(browser, resolved);
    try {
      return await scrapeInContext(context, input, resolved);
    } finally {
      await context.close().catch(() => undefined);
    }
  } catch (error) {
    return failure(input, 'ERROR', errorMessage(error));
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

/* -------------------------------------------------------------- many products */

/**
 * Scrape several products sequentially in one browser.
 *
 * Sequential on purpose: Flipkart rate-limits aggressively, and a single browser
 * with one tab at a time is the difference between a clean run and a captcha.
 *
 * `onResult` fires after each product, before the next one starts — use it to
 * persist incrementally so a crash at item 900 of 1000 doesn't lose the run.
 * The loop stops early if a product stays BLOCKED through every back-off;
 * anything after that would only be blocked too, and the untouched inputs are
 * better left for a resumed run.
 */
export async function scrapeProducts(
  inputs: ScrapeInput[],
  options: ScraperOptions = {},
  onResult?: ResultSink,
): Promise<ScrapeResult[]> {
  const resolved = resolveOptions(options);
  setVerbose(resolved.verbose);

  const results: ScrapeResult[] = [];
  const browser = await launchBrowser(resolved);

  try {
    for (const [index, input] of inputs.entries()) {
      if (resolved.signal?.aborted) break;
      if (index > 0) await jitteredDelay(resolved.delayMs, resolved.delayJitterMs, resolved.signal);
      if (resolved.signal?.aborted) break;

      log.step(`\n=== [${index + 1}/${inputs.length}] ${input.sku} — ${input.targetSeller} ===`);
      const result = await scrapeWithBackoff(browser, input, resolved);

      // An abort mid-product produces a torn result — the context was closed out
      // from under Playwright. Dropping it unreported leaves the row exactly as
      // it was, so a later resume scrapes it cleanly instead of trusting a
      // failure we caused ourselves.
      if (resolved.signal?.aborted) {
        log.warn(`cancelled during ${input.sku} — leaving it unrecorded for resume.`);
        break;
      }

      results.push(result);
      await onResult?.(result, index);

      if (result.status === 'BLOCKED') {
        const remaining = inputs.length - index - 1;
        log.error(
          `still blocked after ${resolved.blockRetries} back-off(s) — stopping with ${remaining} product(s) unprocessed.`,
        );
        break;
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  return results;
}

/* ---------------------------------------------------------------- internals */

/**
 * Run one product, pausing and retrying while it comes back BLOCKED.
 *
 * The pause doubles each time: a bot wall clears on Flipkart's schedule, not
 * ours, so hammering it at a fixed interval just extends the block.
 */
async function scrapeWithBackoff(
  browser: Browser,
  input: ScrapeInput,
  options: ResolvedOptions,
): Promise<ScrapeResult> {
  let attempts = 1;
  let result = await scrapeOnce(browser, input, options, attempts);

  for (let attempt = 1; attempt <= options.blockRetries && result.status === 'BLOCKED'; attempt++) {
    if (options.signal?.aborted) break;
    const backoffMs = options.blockBackoffMs * 2 ** (attempt - 1);
    log.warn(`blocked — pausing ${Math.round(backoffMs / 1000)}s (back-off ${attempt}/${options.blockRetries})`);
    await jitteredDelay(backoffMs, options.delayJitterMs, options.signal);
    if (options.signal?.aborted) break;
    attempts++;
    result = await scrapeOnce(browser, input, options, attempts);
  }

  return { ...result, attempts };
}

/** One product in its own context, with every throw flattened into a result. */
async function scrapeOnce(
  browser: Browser,
  input: ScrapeInput,
  options: ResolvedOptions,
  attempt: number,
): Promise<ScrapeResult> {
  const context = await createContext(browser, options);

  // Playwright has no notion of an AbortSignal, and a product can be parked in a
  // 20s wait. Closing the context is the one lever that makes those calls return
  // now; the resulting throw is caught below and discarded by the caller.
  const abortContext = (): void => {
    void context.close().catch(() => undefined);
  };
  options.signal?.addEventListener('abort', abortContext, { once: true });

  try {
    // `humanize` only here, not in `scrapeProduct`: idle browsing belongs in the
    // gap *between* products, and a single-product run has no next product.
    return await scrapeInContext(context, input, options, attempt, true);
  } catch (error) {
    return failure(input, 'ERROR', errorMessage(error));
  } finally {
    options.signal?.removeEventListener('abort', abortContext);
    await context.close().catch(() => undefined);
  }
}

async function launchBrowser(options: ResolvedOptions): Promise<Browser> {
  return chromium.launch({
    headless: options.headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
}

async function createContext(browser: Browser, options: ResolvedOptions): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    viewport: { width: 1440, height: 900 },
    locale: 'en-IN',
    storageState: options.storageStatePath,
  });
  context.setDefaultTimeout(options.timeout);
  context.setDefaultNavigationTimeout(options.navigationTimeout);
  return context;
}

/** The actual pipeline, factored out so both entry points share it exactly. */
async function scrapeInContext(
  context: BrowserContext,
  input: ScrapeInput,
  options: ResolvedOptions,
  attempt = 1,
  humanize = false,
): Promise<ScrapeResult> {
  const startedAt = Date.now();
  const page = await context.newPage();
  const step = (name: Parameters<NonNullable<ResolvedOptions['onStep']>>[0]): void => {
    try {
      options.onStep?.(name, input);
    } catch {
      // Progress reporting must never break a scrape.
    }
  };

  let capture: NetworkCapture | null = null;
  if (options.useNetworkCapture) capture = attachNetworkCapture(page);

  try {
    // 1. Open the product page.
    step('opening');
    await openProduct(page, input.productUrl, options);

    // 2. Structured data first — it carries the price, sku and availability.
    step('reading-page');
    const jsonLd = await readProductJsonLd(page);

    const unavailable = await checkAvailability(page, jsonLd);
    if (unavailable) {
      throw new ScrapeError('PRODUCT_UNAVAILABLE', unavailable);
    }

    // 3. Main price.
    step('main-price');
    const mainPrice = await getMainPrice(page, jsonLd, options);
    if (mainPrice === null) {
      throw new ScrapeError('MAIN_PRICE_NOT_FOUND', 'Could not read the product page price.');
    }

    // 4. Into the seller list.
    step('opening-sellers');
    const entry = await findSellerListEntry(page, jsonLd, input.productUrl);
    await openSellerDrawer(page, entry, options);

    // 5. Find the seller, paging as needed.
    step('finding-seller');
    const { seller, sellers, source, sellersScanned, showMoreClicks } = await getSellerPrice(
      page,
      input.targetSeller,
      capture,
      options,
    );

    // Who holds the buy box. Inferred from the same list we just read, so it
    // costs no extra page work; null when it cannot be told apart.
    const buyboxSeller = pickBuyboxSeller(sellers, mainPrice, source === 'dom');

    if (!seller) {
      throw new ScrapeError(
        'SELLER_NOT_FOUND',
        `"${input.targetSeller}" is not among the ${sellersScanned} sellers listed for this product.`,
      );
    }
    if (seller.price === null) {
      throw new ScrapeError('SELLER_PRICE_NOT_FOUND', `Found "${seller.name}" but could not read its price.`);
    }

    // 6. Compare.
    step('comparing');
    log.step('Comparing prices...');
    const { difference, isPriceDifferent } = comparePrice(mainPrice, seller.price);

    step('done');
    log.step('Done.');
    return {
      fsn: input.fsn,
      sku: input.sku,
      sellerName: seller.name,
      buyboxSellerName: buyboxSeller?.name ?? null,
      mainPrice,
      sellerPrice: seller.price,
      difference,
      isPriceDifferent,
      productUrl: input.productUrl,
      status: 'OK',
      sellersScanned,
      showMoreClicks,
      source,
      durationMs: Date.now() - startedAt,
      attempts: attempt,
    };
  } catch (error) {
    const screenshotPath = await captureFailureScreenshot(page, input, options, attempt);
    const tail = { durationMs: Date.now() - startedAt, attempts: attempt, screenshotPath };

    if (error instanceof ScrapeError) {
      log.error(`${error.code}: ${error.message}`);
      return { ...failure(input, error.code, error.message), ...tail };
    }
    log.error(errorMessage(error));
    return { ...failure(input, 'ERROR', errorMessage(error)), ...tail };
  } finally {
    capture?.detach();

    // Idle browsing before this tab goes away. The result above is already
    // built and returned by this point, so nothing here can change it — it only
    // fills the handover to the next product with human-looking activity.
    if (humanize) {
      await humanBehavior(page, { enabled: options.humanLikeBehavior, signal: options.signal });
    }

    await page.close().catch(() => undefined);
  }
}

/**
 * Screenshot a failed product. Returns the path written, or undefined.
 *
 * The name carries sku, fsn and attempt because none of them is unique alone:
 * sku can be blank, the same sku can appear under two URLs, and a back-off retry
 * of the same row would otherwise overwrite the evidence from the first failure.
 */
async function captureFailureScreenshot(
  page: Page,
  input: ScrapeInput,
  options: ResolvedOptions,
  attempt: number,
): Promise<string | undefined> {
  if (!options.screenshotOnFailureDir) return undefined;

  const safe = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
  const path = `${options.screenshotOnFailureDir}/${safe(input.sku)}-${safe(input.fsn)}-a${attempt}.png`;

  const written = await page
    .screenshot({ path, fullPage: false })
    .then(() => true)
    .catch(() => false);

  if (!written) return undefined;
  log.info(`failure screenshot written to ${path}`);
  return path;
}

/** Build a result for a run that could not produce prices. */
function failure(input: ScrapeInput, status: ScrapeStatus, message: string): ScrapeResult {
  return {
    fsn: input.fsn,
    sku: input.sku,
    sellerName: null,
    buyboxSellerName: null,
    mainPrice: null,
    sellerPrice: null,
    difference: null,
    isPriceDifferent: false,
    productUrl: input.productUrl,
    status,
    message,
  };
}
