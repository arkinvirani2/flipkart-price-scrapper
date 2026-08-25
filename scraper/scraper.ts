/**
 * Orchestration: open the product, read both prices, compare, return a result.
 *
 * Every classified failure produces a result object with a `status` — the
 * function only throws on genuinely unexpected errors, and even then
 * `scrapeProduct` converts it into a result rather than exploding on the caller.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { humanBehavior } from './humanBehavior';
import { comparePrice, pickBuyboxSeller, sellerNamesMatch } from './parser';
import {
  checkAvailability,
  findSellerListEntry,
  getFulfilledBy,
  getMainPrice,
  openProduct,
  readPageSignals,
  readProductJsonLd,
} from './productPage';
import { attachNetworkCapture, getSellerPrice, openSellerDrawer, type NetworkCapture } from './sellerDrawer';
import { BLOCKED_HOSTS, BLOCKED_RESOURCE_TYPES } from './selectors';
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
  delay,
  errorMessage,
  jitteredDelay,
  log,
  resolveOptions,
  runAsWorker,
  setVerbose,
} from './utils';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Floor for the gap between worker starts, used when the run sets no pacing of
 * its own. Enough for one context to boot and get its first navigation away
 * before the next worker begins.
 */
const WORKER_RAMP_MS = 750;

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
      return await scrapeInContext(context, input, resolved, 0);
    } finally {
      await context.close().catch(() => undefined);
    }
  } catch (error) {
    return failure(input, 'ERROR', errorMessage(error));
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

/* ---------------------------------------------------------------- block gate */

/**
 * A shared "everybody stop" timer for the worker pool.
 *
 * A bot wall is a fact about our IP, not about one product, so when any worker
 * is told to back off every other worker must back off too. Without this, one
 * worker would sit out its 60s penalty while the other two kept hammering the
 * same wall and kept extending it.
 *
 * `hold` only ever pushes the deadline later, never earlier, so two workers
 * blocking at once cannot shorten each other's penalty.
 */
class BlockGate {
  private until = 0;

  hold(ms: number): void {
    this.until = Math.max(this.until, Date.now() + ms);
  }

  private remaining(): number {
    return Math.max(0, this.until - Date.now());
  }

  /** Resolve once the pool is free to make requests again. */
  async wait(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const left = this.remaining();
      if (left <= 0 || signal?.aborted) return;
      // Woken in slices so a Stop mid-back-off is honoured promptly.
      await delay(Math.min(left, 1_000), signal);
    }
  }
}

/* -------------------------------------------------------------- many products */

/**
 * Scrape several products, `options.concurrency` at a time, in one browser.
 *
 * Each worker owns its own browser context and its own pacing, and pulls the
 * next product off a shared queue as soon as it is free. `concurrency: 1`
 * reproduces the original strictly-sequential behaviour exactly.
 *
 * `onResult` fires as each product finishes — use it to persist incrementally so
 * a crash at item 900 of 1000 doesn't lose the run. It fires in completion
 * order, which under concurrency is not input order; the returned array is
 * sorted back into input order, and the journal is keyed by product rather than
 * by position, so neither resume nor any caller depends on the interleaving.
 *
 * The pool stops taking new work if a product stays BLOCKED through every
 * back-off; anything after that would only be blocked too. Products already in
 * flight are allowed to finish and are still reported, and the untouched inputs
 * are left for a resumed run.
 */
export async function scrapeProducts(
  inputs: ScrapeInput[],
  options: ScraperOptions = {},
  onResult?: ResultSink,
): Promise<ScrapeResult[]> {
  const resolved = resolveOptions(options);
  setVerbose(resolved.verbose);

  // Slots, not pushes: workers finish out of order, and every caller so far has
  // read the returned array as "the inputs, in the order I gave them".
  const slots: (ScrapeResult | null)[] = new Array(inputs.length).fill(null);
  const gate = new BlockGate();

  const workerCount = Math.max(1, Math.min(Math.trunc(resolved.concurrency) || 1, inputs.length));
  if (workerCount > 1) log.info(`scraping with ${workerCount} concurrent workers`);

  let cursor = 0;
  let stopIntake = false;

  /** Hand out the next input, or null when the pool should wind down. */
  const takeNext = (): number | null => {
    if (stopIntake || resolved.signal?.aborted || cursor >= inputs.length) return null;
    // A drain request stops intake without tearing down work in flight.
    if (resolved.shouldStop?.()) return null;
    return cursor++;
  };

  const browser = await launchBrowser(resolved);

  const runWorker = async (workerId: number): Promise<void> => {
    // Stagger the start so a ten-worker pool does not open ten contexts and
    // fire ten navigations in the same instant. That opening burst is both the
    // most block-prone moment of a run and the worst moment for CPU: every
    // context boots at once, and the page-render waits inside a product are
    // measured against a machine that is briefly saturated. Spacing the starts
    // by the run's own pacing also leaves the workers out of lockstep for the
    // whole batch, so they keep arriving spread out rather than in waves.
    if (workerId > 0) {
      await delay(workerId * Math.max(resolved.delayMs, WORKER_RAMP_MS), resolved.signal);
      if (resolved.signal?.aborted) return;
    }

    for (;;) {
      const index = takeNext();
      if (index === null) return;

      // Honour a pool-wide back-off before touching the network.
      await gate.wait(resolved.signal);
      if (resolved.signal?.aborted || stopIntake) return;

      const input = inputs[index];
      log.step(`\n=== [${index + 1}/${inputs.length}] ${input.sku} — ${input.targetSeller} ===`);

      const result = await scrapeWithBackoff(browser, input, resolved, gate, workerId);

      // An abort mid-product produces a torn result — the context was closed out
      // from under Playwright. Dropping it unreported leaves the row exactly as
      // it was, so a later resume scrapes it cleanly instead of trusting a
      // failure we caused ourselves.
      if (resolved.signal?.aborted) {
        log.warn(`cancelled during ${input.sku} — leaving it unrecorded for resume.`);
        return;
      }

      slots[index] = result;
      await onResult?.(result, index);

      if (result.status === 'BLOCKED') {
        stopIntake = true;
        log.error(
          `still blocked after ${resolved.blockRetries} back-off(s) — no new products will be started.`,
        );
        return;
      }
    }
  };

  try {
    // Every worker's logging is tagged with its id, so the one interleaved
    // stream can still be read back per product.
    await Promise.all(
      Array.from({ length: workerCount }, (_, workerId) => runAsWorker(workerId, () => runWorker(workerId))),
    );
  } finally {
    await browser.close().catch(() => undefined);
  }

  const results = slots.filter((slot): slot is ScrapeResult => slot !== null);
  const unprocessed = inputs.length - results.length;
  if (stopIntake && unprocessed > 0) {
    log.error(`${unprocessed} product(s) left unprocessed — resume to continue.`);
  }
  return results;
}

/* ---------------------------------------------------------------- internals */

/**
 * Run one product, pausing and retrying while it comes back BLOCKED.
 *
 * The pause doubles each time: a bot wall clears on Flipkart's schedule, not
 * ours, so hammering it at a fixed interval just extends the block. The pause is
 * published to the shared gate so the rest of the pool waits it out too.
 */
async function scrapeWithBackoff(
  browser: Browser,
  input: ScrapeInput,
  options: ResolvedOptions,
  gate: BlockGate,
  workerId: number,
): Promise<ScrapeResult> {
  let attempts = 1;
  let result = await scrapeOnce(browser, input, options, attempts, workerId);

  for (let attempt = 1; attempt <= options.blockRetries && result.status === 'BLOCKED'; attempt++) {
    if (options.signal?.aborted) break;
    const backoffMs = options.blockBackoffMs * 2 ** (attempt - 1);
    log.warn(`blocked — pausing ${Math.round(backoffMs / 1000)}s (back-off ${attempt}/${options.blockRetries})`);

    gate.hold(backoffMs);
    await gate.wait(options.signal);
    if (options.signal?.aborted) break;

    attempts++;
    result = await scrapeOnce(browser, input, options, attempts, workerId);
  }

  return { ...result, attempts };
}

/** One product in its own context, with every throw flattened into a result. */
async function scrapeOnce(
  browser: Browser,
  input: ScrapeInput,
  options: ResolvedOptions,
  attempt: number,
  workerId: number,
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
    // `betweenProducts` only here, not in `scrapeProduct`: idle browsing and
    // pacing belong in the gap *between* products, and a single-product run has
    // no next product.
    return await scrapeInContext(context, input, options, workerId, attempt, true);
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
  if (options.blockResources) await installResourceBlocking(context);
  return context;
}

/**
 * Drop requests for bytes no extractor reads.
 *
 * A product page pulls roughly ninety images plus fonts and a spread of
 * analytics beacons, none of which contribute a character to a price, a seller
 * name or an availability string. Every one of them competes for the same
 * connection pool as the markup we actually need.
 *
 * Stylesheets and scripts always continue, by construction — see
 * BLOCKED_RESOURCE_TYPES for why blocking CSS would corrupt prices silently
 * rather than fail loudly.
 */
async function installResourceBlocking(context: BrowserContext): Promise<void> {
  await context.route('**/*', (route) => {
    const request = route.request();

    if (BLOCKED_RESOURCE_TYPES.includes(request.resourceType())) {
      void route.abort().catch(() => undefined);
      return;
    }

    // Suffix match so subdomains are covered, anchored on a dot boundary so
    // "notgoogle-analytics.com" cannot match "google-analytics.com".
    let host = '';
    try {
      host = new URL(request.url()).hostname;
    } catch {
      // Unparseable URL: let it through rather than guess.
    }
    if (host && BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) {
      void route.abort().catch(() => undefined);
      return;
    }

    void route.continue().catch(() => undefined);
  });
}

/** The actual pipeline, factored out so both entry points share it exactly. */
async function scrapeInContext(
  context: BrowserContext,
  input: ScrapeInput,
  options: ResolvedOptions,
  workerId: number,
  attempt = 1,
  betweenProducts = false,
): Promise<ScrapeResult> {
  const startedAt = Date.now();
  const page = await context.newPage();
  const step = (name: Parameters<NonNullable<ResolvedOptions['onStep']>>[0]): void => {
    try {
      options.onStep?.(name, input, workerId);
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

    // One read of the page's text answers the availability question. Structured
    // data misses some of these — a listing whose JSON-LD still says InStock can
    // render "Out of stock" — so the text check is not redundant with the above.
    const signals = await readPageSignals(page);
    const unavailable = await checkAvailability(page, jsonLd, signals);
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

    // When the main listing is already the account's listing there is no seller
    // comparison to make. Do not open the seller drawer for this product.
    if (sellerNamesMatch(fulfilledBy, input.targetSeller)) {
      step('done');
      return {
        fsn: input.fsn,
        sku: input.sku,
        sellerName: fulfilledBy,
        buyboxSellerName: fulfilledBy,
        mainListingIsAccountSeller: true,
        mainPrice,
        sellerPrice: mainPrice,
        difference: null,
        isPriceDifferent: false,
        productUrl: input.productUrl,
        status: 'OK',
        durationMs: Date.now() - startedAt,
        attempts: attempt,
      };
    }

    // 5. Into the seller list.
    step('opening-sellers');
    const entry = await findSellerListEntry(page, jsonLd, input.productUrl, input.fsn);
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

    // The handover to this worker's next product. The result above is already
    // built and returned by this point, so nothing here can change it.
    //
    // Idle browsing and the politeness throttle run CONCURRENTLY, not one after
    // the other. They are two ways of spending the same gap — the mouse drift
    // happens on the finished page while the throttle counts down — so running
    // them in series was paying for that gap twice.
    if (betweenProducts) {
      await Promise.all([
        humanBehavior(page, { enabled: options.humanLikeBehavior, signal: options.signal }),
        jitteredDelay(options.delayMs, options.delayJitterMs, options.signal),
      ]);
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
    mainListingIsAccountSeller: false,
    mainPrice: null,
    sellerPrice: null,
    difference: null,
    isPriceDifferent: false,
    productUrl: input.productUrl,
    status,
    message,
  };
}
