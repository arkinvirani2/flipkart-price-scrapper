/**
 * Orchestration: open the product, read both prices, compare, return a result.
 *
 * Every classified failure produces a result object with a `status` — the
 * function only throws on genuinely unexpected errors, and even then
 * `scrapeProduct` converts it into a result rather than exploding on the caller.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { RateLimiter, fetchProductSellers, type ApiOptions, type ApiProduct } from './flipkartApi';
import { humanBehavior } from './humanBehavior';
import { comparePrice, findSeller, normalizeSellerName, pickBuyboxSeller } from './parser';
import {
  checkAvailability,
  findSellerListEntry,
  getFulfilledBy,
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
import {
  ScrapeError,
  errorMessage,
  jitteredDelay,
  log,
  pidFromUrl,
  resolveOptions,
  setVerbose,
} from './utils';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** First pause after a rate-limited API call. Doubles per retry. See its use below. */
const API_RETRY_BACKOFF_MS = 700;

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

  // One product goes through the same fast-then-browser sequence a batch does,
  // so a single scrape and a batch of one cannot disagree about a result.
  if (resolved.useFastApi) {
    const [result] = await scrapeProductsFast([input], resolved);
    if (result) return result;
  }

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
 * Scrape several products, fastest workable path first.
 *
 * Two implementations sit behind this one entry point:
 *
 *   fast (default) — Flipkart's own seller endpoint over plain HTTP, several
 *     products in flight, no browser at all. ~60x quicker. Any product it
 *     cannot answer for drops through to the browser, so the fast path can
 *     only ever save time, never cost a result.
 *
 *   browser — the original PDP-then-seller-page Playwright pipeline, kept
 *     whole. Used for every product when `useFastApi` is false, and per
 *     product as the fast path's fallback.
 *
 * `onResult` fires as each product finishes — use it to persist incrementally
 * so a crash at item 900 of 1000 doesn't lose the run. On the fast path
 * products finish out of order, so treat its `index` as the input's position,
 * not a completion count.
 *
 * Either way the run stops early once a product stays BLOCKED through every
 * back-off: anything after that would only be blocked too, and the untouched
 * inputs are better left for a resumed run.
 */
export async function scrapeProducts(
  inputs: ScrapeInput[],
  options: ScraperOptions = {},
  onResult?: ResultSink,
): Promise<ScrapeResult[]> {
  const resolved = resolveOptions(options);
  setVerbose(resolved.verbose);

  return resolved.useFastApi
    ? scrapeProductsFast(inputs, resolved, onResult)
    : scrapeProductsWithBrowser(inputs, resolved, onResult);
}

/* --------------------------------------------------------------- fast path */

/**
 * The fast path: `concurrency` workers pulling from one queue, all of them
 * paced by a single shared rate limiter.
 *
 * Concurrency and request rate are separate knobs on purpose. Flipkart does not
 * object to parallel callers; it objects to burst rate. Measured on a real
 * 202-product batch: 8 workers with no pacing drew 87 rejections, and the same
 * 8 workers spaced 100ms apart drew none. So the limiter — not the pool size —
 * is what keeps a run clean, and it is the thing that adapts when Flipkart does
 * push back.
 *
 * A browser is launched only if some product actually needs the fallback, and
 * fallbacks are serialised behind `browserLock` so the browser path keeps the
 * one-at-a-time cadence it was designed around even while the fast path runs
 * wide.
 */
async function scrapeProductsFast(
  inputs: ScrapeInput[],
  options: ResolvedOptions,
  onResult?: ResultSink,
): Promise<ScrapeResult[]> {
  const limiter = new RateLimiter(options.requestGapMs);
  const apiOptions: ApiOptions = {
    requestGapMs: options.requestGapMs,
    retries: options.blockRetries,
    // Deliberately not `blockBackoffMs`. That one is sized for a browser hitting
    // a captcha wall, which clears on Flipkart's schedule in tens of seconds.
    // An API rate limit clears in well under a second, and waiting 60s for it is
    // the single biggest cause of one product taking far longer than its
    // neighbours. 700ms doubling gives ~4.9s worst case instead of ~35s.
    backoffMs: API_RETRY_BACKOFF_MS,
    timeoutMs: options.timeout,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    signal: options.signal,
  };

  log.step(
    `Fast path: ${inputs.length} product(s), up to ${options.concurrency} in flight, ${limiter.gapMs}ms between requests.`,
  );

  // Filled by original index so the returned array keeps input order even
  // though products finish in whatever order Flipkart answers them.
  const slots: Array<ScrapeResult | undefined> = new Array(inputs.length);
  let blocked = false;

  // Lazily created, shared by every fallback, and closed once at the end. Held
  // in a box because it is assigned from inside `runFallback`.
  const browser: { current: Browser | null } = { current: null };
  let browserLock: Promise<void> = Promise.resolve();

  const runFallback = async (input: ScrapeInput): Promise<ScrapeResult> => {
    // Chain onto the lock so only one product is ever in the browser at a time.
    const previous = browserLock;
    let release!: () => void;
    browserLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      browser.current ??= await launchBrowser(options);
      return await scrapeWithBackoff(browser.current, input, options);
    } finally {
      release();
    }
  };

  /**
   * Run `queue` (a list of positions into `inputs`) across the worker pool.
   *
   * `accept` decides whether a result is worth keeping. On the first pass every
   * result is kept; on the retry pass only an improvement is, which is what
   * makes retrying unable to damage a row it cannot help.
   */
  const runPass = async (
    queue: number[],
    label: string,
    accept: (next: ScrapeResult, previous: ScrapeResult | undefined) => boolean,
    attempt = 1,
  ): Promise<void> => {
    let cursor = 0;
    const workers = Math.max(1, Math.min(options.concurrency, queue.length));

    const worker = async (): Promise<void> => {
      for (;;) {
        if (blocked || options.signal?.aborted) return;
        const slot = cursor++;
        if (slot >= queue.length) return;

        const index = queue[slot];
        const input = inputs[index];

        log.step(`${label}[${slot + 1}/${queue.length}] ${input.sku} — ${input.targetSeller}`);
        const result = await scrapeOneFast(input, limiter, apiOptions, options, runFallback, attempt);

        // An abort mid-product produces a torn result. Dropping it unreported
        // leaves the row exactly as it was, so a later resume scrapes it cleanly
        // instead of trusting a failure we caused ourselves.
        if (options.signal?.aborted) return;

        if (accept(result, slots[index])) {
          slots[index] = result;
          await onResult?.(result, index);
        }

        if (result.status === 'BLOCKED') {
          blocked = true;
          log.error(`still blocked after ${options.blockRetries} retries — stopping the run; the rest stay pending.`);
          return;
        }
      }
    };

    await Promise.all(Array.from({ length: workers }, worker));
  };

  try {
    await runPass(
      inputs.map((_, index) => index),
      '',
      () => true,
    );

    // Second pass over whatever failed. A failure now costs one HTTP request to
    // re-check, so the cheap thing to do is simply ask again rather than hand
    // the user a row to chase manually — a rate limit, a dropped socket or a
    // half-built payload all clear on their own.
    //
    // The retry may only *improve* a row: a result is written back only when it
    // is OK. So a product that genuinely cannot be read keeps the classification
    // the first pass gave it, and no retry can turn a good row bad.
    if (options.retryFailedProducts && !blocked && !options.signal?.aborted) {
      const failed = slots
        .map((result, index) => ({ result, index }))
        .filter(({ result }) => result !== undefined && RETRYABLE_FAILURES.has(result.status))
        .map(({ index }) => index);

      if (failed.length > 0) {
        log.step(`\nRetrying ${failed.length} failed product(s) once more...`);
        const before = failed.length;
        await runPass(failed, 'retry ', (next) => next.status === 'OK', 2);

        const stillFailing = failed.filter((index) => slots[index]?.status !== 'OK').length;
        log.step(`Retry recovered ${before - stillFailing} of ${before} product(s).`);
      }
    }
  } finally {
    await browser.current?.close().catch(() => undefined);
  }

  return slots.filter((result): result is ScrapeResult => result !== undefined);
}

/**
 * Failures worth a second look before we report them.
 *
 * BLOCKED is deliberately absent: it already has its own back-off, and it stops
 * the run rather than marking one product. Everything else here is a state that
 * has been observed to clear on its own — a seller list that arrived
 * half-built, a summary widget that came back empty, a dropped socket.
 */
const RETRYABLE_FAILURES: ReadonlySet<ScrapeStatus> = new Set<ScrapeStatus>([
  'SELLER_NOT_FOUND',
  'SELLER_PRICE_NOT_FOUND',
  'MAIN_PRICE_NOT_FOUND',
  'PRODUCT_UNAVAILABLE',
  'SELLER_LIST_LOAD_FAILED',
  'NO_SELLER_LINK',
  'ERROR',
]);

/**
 * One product through the API, dropping to the browser when the API cannot
 * answer.
 *
 * The distinction that matters: a `ScrapeError` is a *finding* about this
 * product (out of stock, seller absent, wall) and is recorded as-is. Anything
 * else means the call itself did not work — a moved payload shape, a 5xx, a
 * product with no usable id — and the browser gets its turn instead of the row
 * being failed on the fast path's word alone.
 */
async function scrapeOneFast(
  input: ScrapeInput,
  limiter: RateLimiter,
  apiOptions: ApiOptions,
  options: ResolvedOptions,
  runFallback: (input: ScrapeInput) => Promise<ScrapeResult>,
  attempt = 1,
): Promise<ScrapeResult> {
  const startedAt = Date.now();
  const step = (name: Parameters<NonNullable<ResolvedOptions['onStep']>>[0]): void => {
    try {
      options.onStep?.(name, input);
    } catch {
      // Progress reporting must never break a scrape.
    }
  };

  const pid = input.fsn?.trim() || pidFromUrl(input.productUrl);
  if (!pid) {
    log.info('no product id on this row — using the browser.');
    return runFallback(input);
  }

  step('opening');
  try {
    const product = await fetchProductSellers(pid, limiter, apiOptions);
    step('finding-seller');
    const result = resultFromApi(input, product, startedAt, attempt);
    step('done');
    return result;
  } catch (error) {
    if (options.signal?.aborted) return failure(input, 'ERROR', 'cancelled');

    if (error instanceof ScrapeError) {
      // A wall is about our traffic, not this product — the browser is no more
      // welcome than we were, so record it and let the run back off.
      if (error.code === 'BLOCKED') {
        log.error(`${error.code}: ${error.message}`);
        return {
          ...failure(input, error.code, error.message),
          durationMs: Date.now() - startedAt,
          source: 'api',
        };
      }
      log.error(`${error.code}: ${error.message}`);
      return {
        ...failure(input, error.code, error.message),
        durationMs: Date.now() - startedAt,
        source: 'api',
      };
    }

    log.warn(`fast path unavailable for ${input.sku} (${errorMessage(error)}) — falling back to the browser.`);
    return runFallback(input);
  }
}

/**
 * Turn one API response into a result, classifying the same way the DOM path does.
 *
 * Unlike the browser pipeline this never throws to signal a classified failure,
 * because by the time we get here we already hold the whole seller list — and a
 * failed row that *silently drops what it did read* is the thing that makes a
 * user distrust the tool. An out-of-stock product whose page still lists your
 * seller at ₹329 should say ₹329 and say "out of stock", not go blank.
 *
 * That is presentation only. Every consumer gates on `status === 'OK'` before
 * reading a price — the rules return NO_DATA and the history builder skips the
 * row entirely — so filling these fields in cannot move a recommendation.
 */
function resultFromApi(input: ScrapeInput, product: ApiProduct, startedAt: number, attempt = 1): ScrapeResult {
  // Flipkart's summary widget carries the headline price, but the buy-box
  // seller's own price is the same number by definition — so a summary that
  // came back empty is recoverable rather than fatal.
  const buybox = product.sellers.find((seller) => seller.name === product.buyboxSellerName);
  const mainPrice = product.mainPrice ?? buybox?.price ?? null;
  const seller = findSeller(product.sellers, input.targetSeller);

  // Everything we managed to read, carried onto success and failure alike.
  const observed = {
    sellerName: seller?.name ?? null,
    // The API states the winner outright via its `selected` flag; matching on
    // price is only the fallback for a payload that omits it.
    buyboxSellerName:
      product.buyboxSellerName ?? pickBuyboxSeller(product.sellers, mainPrice, true)?.name ?? null,
    mainPrice,
    sellerPrice: seller?.price ?? null,
    sellersScanned: product.sellers.length,
    showMoreClicks: 0,
    source: 'api' as const,
    durationMs: Date.now() - startedAt,
    attempts: attempt,
  };

  const classified = (status: ScrapeStatus, message: string): ScrapeResult => ({
    ...failure(input, status, message),
    ...observed,
  });

  if (product.unavailableReason) return classified('PRODUCT_UNAVAILABLE', product.unavailableReason);
  if (mainPrice === null) return classified('MAIN_PRICE_NOT_FOUND', 'The seller API returned no page price.');

  if (!seller) {
    // Name the near misses. When a run reports "seller not found" but the user
    // can plainly see their shop on the page, the cause is almost always a
    // spelling difference between the sheet and Flipkart — and the only useful
    // thing this message can do is show both spellings side by side.
    const wanted = normalizeSellerName(input.targetSeller);
    const near = product.sellers
      .filter((candidate) => {
        const name = normalizeSellerName(candidate.name);
        return name.includes(wanted) || wanted.includes(name);
      })
      .map((candidate) => `"${candidate.name}"`);

    const hint = near.length > 0 ? ` Closest names on the page: ${near.join(', ')}.` : '';
    return classified(
      'SELLER_NOT_FOUND',
      `"${input.targetSeller}" is not among the ${product.sellers.length} sellers listed for this product.${hint}`,
    );
  }

  if (seller.price === null) {
    return classified('SELLER_PRICE_NOT_FOUND', `Found "${seller.name}" but the API carried no price for it.`);
  }

  const { difference, isPriceDifferent } = comparePrice(mainPrice, seller.price);

  return {
    fsn: input.fsn,
    sku: input.sku,
    ...observed,
    sellerName: seller.name,
    mainPrice,
    sellerPrice: seller.price,
    difference,
    isPriceDifferent,
    productUrl: input.productUrl,
    status: 'OK',
  };
}

/* ------------------------------------------------------------ browser path */

/**
 * Scrape several products sequentially in one browser.
 *
 * Sequential on purpose: Flipkart rate-limits aggressively, and a single browser
 * with one tab at a time is the difference between a clean run and a captcha.
 */
async function scrapeProductsWithBrowser(
  inputs: ScrapeInput[],
  resolved: ResolvedOptions,
  onResult?: ResultSink,
): Promise<ScrapeResult[]> {
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

    // 4. Who the page says is fulfilling this listing — the winning seller.
    const fulfilledBy = await getFulfilledBy(page);
    if (fulfilledBy) log.info(`fulfilled by: ${fulfilledBy}`);

    // 5. Into the seller list.
    step('opening-sellers');
    const entry = await findSellerListEntry(page, jsonLd, input.productUrl);
    await openSellerDrawer(page, entry, options);

    // 6. Find the seller, paging as needed.
    step('finding-seller');
    const { seller, sellers, source, sellersScanned, showMoreClicks } = await getSellerPrice(
      page,
      input.targetSeller,
      capture,
      options,
    );

    // Who holds the buy box. The PDP's "Fulfilled by" line states it outright, so
    // that wins; inferring it from the seller list is only the fallback for pages
    // that carry no such line.
    const buyboxSellerName = fulfilledBy ?? pickBuyboxSeller(sellers, mainPrice, source === 'dom')?.name ?? null;

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
      buyboxSellerName,
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
