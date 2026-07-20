/**
 * Orchestration: open the product, read both prices, compare, return a result.
 *
 * Every classified failure produces a result object with a `status` — the
 * function only throws on genuinely unexpected errors, and even then
 * `scrapeProduct` converts it into a result rather than exploding on the caller.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { comparePrice } from './parser';
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
      if (index > 0) await jitteredDelay(resolved.delayMs, resolved.delayJitterMs);

      log.step(`\n=== [${index + 1}/${inputs.length}] ${input.sku} — ${input.targetSeller} ===`);
      const result = await scrapeWithBackoff(browser, input, resolved);

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
  let result = await scrapeOnce(browser, input, options);

  for (let attempt = 1; attempt <= options.blockRetries && result.status === 'BLOCKED'; attempt++) {
    const backoffMs = options.blockBackoffMs * 2 ** (attempt - 1);
    log.warn(`blocked — pausing ${Math.round(backoffMs / 1000)}s (back-off ${attempt}/${options.blockRetries})`);
    await jitteredDelay(backoffMs, options.delayJitterMs);
    result = await scrapeOnce(browser, input, options);
  }

  return result;
}

/** One product in its own context, with every throw flattened into a result. */
async function scrapeOnce(browser: Browser, input: ScrapeInput, options: ResolvedOptions): Promise<ScrapeResult> {
  const context = await createContext(browser, options);
  try {
    return await scrapeInContext(context, input, options);
  } catch (error) {
    return failure(input, 'ERROR', errorMessage(error));
  } finally {
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
): Promise<ScrapeResult> {
  const startedAt = Date.now();
  const page = await context.newPage();

  let capture: NetworkCapture | null = null;
  if (options.useNetworkCapture) capture = attachNetworkCapture(page);

  try {
    // 1. Open the product page.
    await openProduct(page, input.productUrl, options);

    // 2. Structured data first — it carries the price, sku and availability.
    const jsonLd = await readProductJsonLd(page);

    const unavailable = await checkAvailability(page, jsonLd);
    if (unavailable) {
      throw new ScrapeError('PRODUCT_UNAVAILABLE', unavailable);
    }

    // 3. Main price.
    const mainPrice = await getMainPrice(page, jsonLd, options);
    if (mainPrice === null) {
      throw new ScrapeError('MAIN_PRICE_NOT_FOUND', 'Could not read the product page price.');
    }

    // 4. Into the seller list.
    const entry = await findSellerListEntry(page, jsonLd, input.productUrl);
    await openSellerDrawer(page, entry, options);

    // 5. Find the seller, paging as needed.
    const { seller, source, sellersScanned, showMoreClicks } = await getSellerPrice(
      page,
      input.targetSeller,
      capture,
      options,
    );

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
    log.step('Comparing prices...');
    const { difference, isPriceDifferent } = comparePrice(mainPrice, seller.price);

    log.step('Done.');
    return {
      fsn: input.fsn,
      sku: input.sku,
      sellerName: seller.name,
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
    };
  } catch (error) {
    await captureFailureScreenshot(page, input, options);

    if (error instanceof ScrapeError) {
      log.error(`${error.code}: ${error.message}`);
      return { ...failure(input, error.code, error.message), durationMs: Date.now() - startedAt };
    }
    log.error(errorMessage(error));
    return { ...failure(input, 'ERROR', errorMessage(error)), durationMs: Date.now() - startedAt };
  } finally {
    capture?.detach();
    await page.close().catch(() => undefined);
  }
}

async function captureFailureScreenshot(page: Page, input: ScrapeInput, options: ResolvedOptions): Promise<void> {
  if (!options.screenshotOnFailureDir) return;
  const safeSku = input.sku.replace(/[^A-Za-z0-9_-]/g, '_');
  const path = `${options.screenshotOnFailureDir}/${safeSku}-failure.png`;
  await page.screenshot({ path, fullPage: false }).catch(() => undefined);
  log.info(`failure screenshot written to ${path}`);
}

/** Build a result for a run that could not produce prices. */
function failure(input: ScrapeInput, status: ScrapeStatus, message: string): ScrapeResult {
  return {
    fsn: input.fsn,
    sku: input.sku,
    sellerName: null,
    mainPrice: null,
    sellerPrice: null,
    difference: null,
    isPriceDifferent: false,
    productUrl: input.productUrl,
    status,
    message,
  };
}
