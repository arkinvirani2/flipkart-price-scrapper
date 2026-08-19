/**
 * Dashboard-facing types.
 *
 * The scraper's own types are re-exported rather than redefined — `ScrapeResult`
 * is the contract the journal is written in, and duplicating it here would be
 * the fastest way to let the two drift apart.
 */

import type { ScrapeInput, ScrapeResult, ScrapeStatus, ScrapeStep } from '@/scraper/types';

export type { ScrapeInput, ScrapeResult, ScrapeStatus, ScrapeStep };

/* --------------------------------------------------------------------- job */

/**
 * Lifecycle of a batch.
 *
 * `pausing` and `stopping` are transient: the control API returns immediately
 * while the runner finishes what it is doing, and the UI needs to show that
 * in-between state rather than lying about being already paused.
 *
 * `interrupted` is set by crash recovery at boot, never by the runner itself.
 */
export type JobState =
  | 'draft'
  | 'queued'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'completed'
  | 'interrupted';

/** States from which the runner can be started or resumed. */
export const RESUMABLE_STATES: readonly JobState[] = ['draft', 'queued', 'paused', 'stopped', 'interrupted'];

/** States where the runner currently owns the job. */
export const ACTIVE_STATES: readonly JobState[] = ['running', 'pausing', 'stopping'];

export type RowStatus = 'pending' | 'running' | 'success' | 'failed' | 'paused' | 'cancelled';

/** The subset of ScraperOptions a dashboard user is allowed to set per job. */
export interface JobOptions {
  delayMs: number;
  delayJitterMs: number;
  timeout: number;
  blockBackoffMs: number;
  blockRetries: number;
  useNetworkCapture: boolean;
  /** Local-only convenience: watch the browser work. Useless on a headless host. */
  headed: boolean;
}

export const DEFAULT_JOB_OPTIONS: JobOptions = {
  // 1500ms is the pacing the scraper's own docs recommend for large batches;
  // defaulting to it means the dashboard is polite out of the box.
  delayMs: 1500,
  delayJitterMs: 400,
  timeout: 20_000,
  blockBackoffMs: 60_000,
  blockRetries: 3,
  useNetworkCapture: true,
  headed: false,
};

/**
 * How many SKUs landed in each recommendation bucket.
 *
 * Stored on the manifest so the dashboard can show an upload's headline figures
 * without opening its recommendations file.
 */
export interface RecommendationCounts {
  total: number;
  priceChange: number;
  alreadyCorrect: number;
  settlementUnsafe: number;
  buyboxWon: number;
  needsReview: number;
}

/**
 * What the uploaded orders report covered.
 *
 * "Last 24 hours" is measured against the report's own newest order, not the
 * wall clock — a report downloaded this morning still has a well-defined last
 * day, and re-opening the batch next week must not silently empty it.
 */
export interface OrdersWindow {
  start: string;
  end: string;
  last24hStart: string;
  observedDays: number;
  orderItems: number;
  units: number;
  fsnCount: number;
}

/** Persisted as job.json. The durable description of a batch. */
export interface JobManifest {
  id: string;
  name: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  state: JobState;
  total: number;
  options: JobOptions;
  /** Set when recovery finds the job was interrupted mid-run. */
  interruptedAt?: string;

  /**
   * The Flipkart account this upload belongs to — the seller name applied to
   * every row. History is read account-wise, so this is what partitions it.
   * Optional because jobs created before accounts existed have none; those are
   * backfilled from the rows' target seller on load.
   */
  accountName?: string;
  /** When the spreadsheet was uploaded. Mirrors `createdAt` for older jobs. */
  uploadTime?: string;
  /**
   * Headline figures of the orders report this batch was judged against, when
   * one was uploaded. Mirrored onto the manifest so a batch can say what its
   * "last 24 hours" actually covered without opening orders.json.
   */
  ordersWindow?: OrdersWindow;
  /** Filled in once recommendations have been generated for this job. */
  recommendationCounts?: RecommendationCounts;
  recommendationSummary?: string;
  recommendationsGeneratedAt?: string;
}

/**
 * A journal row plus the completion timestamp.
 *
 * The scraper records `durationMs` but not when a product finished — it has no
 * reason to. The dashboard stamps it on arrival so date filters and
 * products-per-hour have something real to work with. Extra fields are ignored
 * by the CLI, so the file stays readable by both.
 */
export type JournalRow = ScrapeResult & { finishedAt?: string };

/** One product in the queue: its input, and its outcome once it has one. */
export interface JobRow {
  index: number;
  key: string;
  sku: string;
  fsn: string;
  targetSeller: string;
  productUrl: string;
  status: RowStatus;
  result?: JournalRow;
  durationMs?: number;
  attempts?: number;
  message?: string;
  screenshotPath?: string;
  finishedAt?: string;
  /** Per-product settlement inputs, carried straight through from the inputs file. */
  currentBankSettlement?: number;
  bankSettlementThreshold?: number;
  /** Flipkart's Benchmark Price for this listing. 0 means "no benchmark published". */
  benchmarkPrice?: number;
  /** System stock count, so a zero-order day can be blamed on the shelf, not the price. */
  stockCount?: number;
  /** The sheet's "Your Listing Price", carried through for the recommendation view. */
  listingPrice?: number;
}

/* ------------------------------------------------------------------- stats */

export interface JobStats {
  total: number;
  pending: number;
  running: number;
  completed: number;
  succeeded: number;
  failed: number;
  /** Percentage of *finished* rows that succeeded. Null before anything finishes. */
  successRate: number | null;
  /** Mean duration of finished rows, ms. Null before anything finishes. */
  averageMs: number | null;
  /** Wall-clock projection for the remaining queue, ms. Null when not derivable. */
  estimatedRemainingMs: number | null;
  queueLength: number;
}

/* -------------------------------------------------------------------- live */

/** What the runner is doing right now. Absent when nothing is running. */
export interface LiveProgress {
  jobId: string;
  rowIndex: number;
  sku: string;
  fsn: string;
  targetSeller: string;
  productUrl: string;
  step: ScrapeStep;
  startedAt: string;
  browserStatus: 'idle' | 'launching' | 'scraping' | 'backing-off' | 'closing';
}

/* -------------------------------------------------------------------- logs */

export type LogLevel = 'step' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  ts: string;
  jobId: string;
  level: LogLevel;
  message: string;
  sku?: string;
  fsn?: string;
  seller?: string;
  rowIndex?: number;
  /** Execution time of the product this line closed, when it closed one. */
  durationMs?: number;
}

/* ------------------------------------------------------------------ events */

/** Server-sent event payloads. One union so the client can switch exhaustively. */
export type JobEvent =
  | { type: 'state'; jobId: string; state: JobState; stats: JobStats }
  | { type: 'progress'; progress: LiveProgress | null }
  | { type: 'row'; jobId: string; row: JobRow; stats: JobStats }
  | { type: 'log'; entry: LogEntry }
  | { type: 'heartbeat'; ts: string };
