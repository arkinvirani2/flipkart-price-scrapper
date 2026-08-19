/**
 * Cross-cutting helpers: logging, retry, polling, option defaults.
 * Deliberately dependency-free apart from Playwright's Page type.
 */

import type { Page } from 'playwright';
import type { ResolvedOptions, ScraperOptions } from './types';

/* ------------------------------------------------------------------ logging */

let verbose = true;

export function setVerbose(v: boolean): void {
  verbose = v;
}

export type LogLevel = 'step' | 'info' | 'warn' | 'error';

/** Receives every log line, regardless of `verbose`. */
export type LogSink = (level: LogLevel, message: string) => void;

let sink: LogSink | null = null;

/**
 * Route log output somewhere besides the console — the dashboard's live log
 * viewer, in practice.
 *
 * The sink is module-global, like `verbose`, which is safe only because a batch
 * is scraped by one sequential loop at a time. Pass `null` to detach.
 */
export function setLogSink(next: LogSink | null): void {
  sink = next;
}

/** Emit to the sink first — it must see the line even when `verbose` is off. */
function emit(level: LogLevel, message: string, consoleWrite: () => void): void {
  try {
    sink?.(level, message);
  } catch {
    // A broken sink must never take down a scrape.
  }
  if (level === 'error' || verbose) consoleWrite();
}

export const log = {
  step(message: string): void {
    emit('step', message, () => console.log(message));
  },
  info(message: string): void {
    emit('info', message, () => console.log(`  ${message}`));
  },
  warn(message: string): void {
    emit('warn', message, () => console.warn(`  ! ${message}`));
  },
  error(message: string): void {
    emit('error', message, () => console.error(`  x ${message}`));
  },
};

/* ------------------------------------------------------------------- errors */

export type ScrapeErrorCode =
  | 'PRODUCT_UNAVAILABLE'
  | 'NO_SELLER_LINK'
  | 'SELLER_LIST_LOAD_FAILED'
  | 'SELLER_NOT_FOUND'
  | 'MAIN_PRICE_NOT_FOUND'
  | 'SELLER_PRICE_NOT_FOUND'
  | 'BLOCKED';

/** An expected, classified failure — distinct from an unhandled crash. */
export class ScrapeError extends Error {
  constructor(readonly code: ScrapeErrorCode, message: string) {
    super(message);
    this.name = 'ScrapeError';
  }
}

/* ------------------------------------------------------------------ options */

export const DEFAULT_OPTIONS: ResolvedOptions = {
  headless: true,
  timeout: 20_000,
  navigationTimeout: 45_000,
  // Runaway guard only. Flipkart caps seller lists well under this; the loop
  // exits on "seller found" or "button gone" long before hitting it.
  maxShowMoreClicks: 40,
  useNetworkCapture: true,
  // The fast path is the default: it produced identical seller prices to the
  // browser on all 202 products of a real batch, and anything it cannot answer
  // falls back to the browser anyway.
  useFastApi: true,
  // 6 workers at a 120ms floor is ~8 requests/second. Measured clean over a
  // full batch; 8/100ms was also clean, so this leaves headroom rather than
  // sitting on the limit.
  concurrency: 6,
  requestGapMs: 120,
  retryFailedProducts: true,
  preferDirectSellerNavigation: true,
  verbose: true,
  // Zero keeps single-product and small-batch runs exactly as fast as before.
  // Long batches should set --delay; see the note on ScraperOptions.delayMs.
  delayMs: 0,
  delayJitterMs: 400,
  blockBackoffMs: 60_000,
  blockRetries: 3,
  humanLikeBehavior: true,
};

/**
 * Merge caller options over the defaults, ignoring keys explicitly set to
 * `undefined`.
 *
 * A plain spread would not: `{...DEFAULT, concurrency: undefined}` yields
 * `undefined`, not the default. Every optional CLI flag arrives exactly that
 * way — `concurrency: args.concurrency` is `undefined` whenever `--concurrency`
 * was not passed — so a plain spread silently erases the default for every flag
 * the user did not type.
 */
export function resolveOptions(options: ScraperOptions = {}): ResolvedOptions {
  const provided = Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as ScraperOptions;

  return { ...DEFAULT_OPTIONS, ...provided };
}

/* ------------------------------------------------------------------ waiting */

/**
 * Poll `check` until it returns a truthy value or `timeoutMs` elapses.
 *
 * This exists so the scraper never sleeps for a fixed duration waiting on
 * content — it waits on the actual condition and returns the moment it holds.
 * The only fixed number involved is the timeout ceiling.
 */
export async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs: number; pollMs?: number; description?: string },
): Promise<T | null> {
  const pollMs = opts.pollMs ?? 150;
  const deadline = Date.now() + opts.timeoutMs;

  for (;;) {
    try {
      const value = await check();
      if (value) return value as T;
    } catch {
      // A transient DOM detach mid-poll is normal on a re-rendering page.
      // Swallow and try again until the deadline.
    }
    if (Date.now() >= deadline) return null;
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Plain sleep. Used only for poll backoff, never as a substitute for a wait.
 *
 * With a `signal`, resolves early on abort — a block back-off can be a full
 * minute, and a Stop that waits it out is a Stop that looks broken.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);

    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }

    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Sleep for `ms` plus a random 0..`jitterMs`.
 *
 * Politeness throttle between products, not a wait for content — a perfectly
 * even request cadence is itself a bot signal, hence the jitter.
 */
export function jitteredDelay(ms: number, jitterMs: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return delay(ms + Math.floor(Math.random() * Math.max(0, jitterMs)), signal);
}

/**
 * Retry `fn` on transient failures — the classic Playwright "element is not
 * attached to the DOM" churn you get while Flipkart hydrates widgets.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { attempts?: number; backoffMs?: number; description?: string } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const backoffMs = opts.backoffMs ?? 400;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      // A classified failure is a real answer, not a flake — do not retry it.
      if (error instanceof ScrapeError) throw error;
      lastError = error;
      if (attempt < attempts) {
        log.warn(
          `${opts.description ?? 'operation'} failed (attempt ${attempt}/${attempts}), retrying: ${errorMessage(error)}`,
        );
        await delay(backoffMs * attempt);
      }
    }
  }
  throw lastError;
}

/* -------------------------------------------------------------------- pages */

/**
 * Wait for the page to settle without hanging on Flipkart's long-lived
 * analytics/beacon connections, which mean `networkidle` frequently never fires.
 */
export async function waitForPageSettled(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
  await page.waitForLoadState('load', { timeout: Math.min(timeoutMs, 10_000) }).catch(() => undefined);
}

/** Close the login interstitial if it is covering the page. Best-effort. */
export async function dismissOverlays(page: Page): Promise<void> {
  try {
    await page.keyboard.press('Escape');
  } catch {
    /* page may be navigating; harmless */
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Pull the Flipkart product id (FSN) out of a product URL. */
export function pidFromUrl(url: string): string | null {
  const match = /[?&]pid=([A-Za-z0-9]+)/.exec(url);
  return match ? match[1] : null;
}
