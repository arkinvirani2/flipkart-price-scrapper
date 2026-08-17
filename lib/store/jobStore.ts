/**
 * Job store: NDJSON on disk, indexed in memory.
 *
 * The journal file is the record of truth — it is appended synchronously before
 * the next product starts, exactly as the CLI does it, so a crash can only lose
 * the product that was in flight. Everything the UI queries (filters, sorting,
 * search, analytics) runs against the in-memory index built from that file, so
 * a 1000-row batch is never re-parsed to answer a request.
 *
 * Deliberately not a database. A batch is a few hundred KB of rows and one
 * writer at a time; the file *is* the checkpoint, and keeping it means the CLI
 * and the dashboard can resume each other's work.
 */

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import {
  appendJournal,
  loadResumableJournal,
  readJournal,
  resultKey,
  rewriteJournal,
} from '@/scraper/journal';
import { sellerNamesMatch } from '@/scraper/parser';
import type { OrdersReport } from '@/lib/demand';
import type { ScrapeInput, ScrapeResult } from '@/scraper/types';
import type {
  JobManifest,
  JobOptions,
  JobRow,
  JobState,
  JobStats,
  JournalRow,
  RowStatus,
} from '@/types/dashboard';
import { ensureDataDir, ensureJobDir, jobDir, jobPaths, jobsDir, newJobId } from './paths';

interface JobRecord {
  manifest: JobManifest;
  inputs: ScrapeInput[];
  rows: JobRow[];
  byKey: Map<string, JobRow>;
}

/**
 * Pinned to globalThis so Next's dev-mode module reloading doesn't hand out a
 * second, empty cache while a job is mid-flight.
 */
const cache: Map<string, JobRecord> = ((globalThis as Record<string, unknown>).__jobCache as Map<
  string,
  JobRecord
>) ?? new Map<string, JobRecord>();
(globalThis as Record<string, unknown>).__jobCache = cache;

/* ------------------------------------------------------------------ create */

export function createJob(
  name: string,
  inputs: ScrapeInput[],
  options: JobOptions,
  accountName?: string,
  /** Per-FSN demand from the orders report, when one was uploaded with the batch. */
  orders?: OrdersReport | null,
): JobManifest {
  ensureDataDir();
  const id = newJobId();
  ensureJobDir(id);

  const createdAt = new Date().toISOString();
  const manifest: JobManifest = {
    id,
    name,
    createdAt,
    state: 'queued',
    total: inputs.length,
    options,
    // The account is the seller name every row carries, so the rows are the
    // fallback when the caller does not name it explicitly.
    accountName: (accountName ?? inputs[0]?.targetSeller ?? '').trim(),
    uploadTime: createdAt,
    ordersWindow: orders
      ? {
          start: orders.windowStart,
          end: orders.windowEnd,
          last24hStart: orders.last24hStart,
          observedDays: orders.observedDays,
          orderItems: orders.totalOrderItems,
          units: orders.totalUnits,
          fsnCount: orders.fsnCount,
        }
      : undefined,
  };

  writeFileSync(jobPaths.inputs(id), JSON.stringify(inputs, null, 2), 'utf8');
  if (orders) writeFileSync(jobPaths.orders(id), JSON.stringify(orders), 'utf8');
  writeManifest(manifest);
  // Create the journal up front so an interrupted job always has a file to read.
  if (!existsSync(jobPaths.journal(id))) writeFileSync(jobPaths.journal(id), '', 'utf8');

  cache.set(id, buildRecord(manifest, inputs, []));
  return manifest;
}

/* -------------------------------------------------------------- hydration */

function writeManifest(manifest: JobManifest): void {
  writeFileSync(jobPaths.manifest(manifest.id), JSON.stringify(manifest, null, 2), 'utf8');
}

/** Build the queue rows by joining inputs against whatever the journal holds. */
function buildRecord(manifest: JobManifest, inputs: ScrapeInput[], journal: JournalRow[]): JobRecord {
  const done = new Map<string, JournalRow>();
  for (const row of journal) done.set(resultKey(row), row);

  const rows: JobRow[] = inputs.map((input, index) => {
    const key = resultKey(input);
    const result = done.get(key);

    return {
      index,
      key,
      sku: input.sku,
      fsn: input.fsn,
      targetSeller: input.targetSeller,
      productUrl: input.productUrl,
      status: statusForResult(result),
      result,
      durationMs: result?.durationMs,
      attempts: result?.attempts,
      message: result?.message,
      screenshotPath: result?.screenshotPath,
      finishedAt: result?.finishedAt,
      currentBankSettlement: input.currentBankSettlement,
      bankSettlementThreshold: input.bankSettlementThreshold,
      benchmarkPrice: input.benchmarkPrice,
      stockCount: input.stockCount,
    };
  });

  const byKey = new Map(rows.map((row) => [row.key, row]));
  return { manifest, inputs, rows, byKey };
}

function statusForResult(result: ScrapeResult | undefined): RowStatus {
  if (!result) return 'pending';
  return result.status === 'OK' ? 'success' : 'failed';
}

/** Load a job from disk, or return the cached index. */
export function getJob(jobId: string): JobRecord | null {
  const cached = cache.get(jobId);
  if (cached) return cached;

  const manifestPath = jobPaths.manifest(jobId);
  if (!existsSync(manifestPath)) return null;

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as JobManifest;
    const inputs = JSON.parse(readFileSync(jobPaths.inputs(jobId), 'utf8')) as ScrapeInput[];

    // Jobs created before accounts existed have neither field. Backfilling in
    // memory keeps them visible in the account-wise views without rewriting
    // files the user never asked us to touch.
    if (!manifest.accountName) manifest.accountName = inputs[0]?.targetSeller ?? '';
    if (!manifest.uploadTime) manifest.uploadTime = manifest.createdAt;
    // readJournal, not the resume filter: the UI should show BLOCKED rows as the
    // failures they were. Blocked rows are only dropped when a run actually starts.
    const journal = readJournal(jobPaths.journal(jobId)) as JournalRow[];

    const record = buildRecord(manifest, inputs, journal);
    cache.set(jobId, record);
    return record;
  } catch {
    return null;
  }
}

export function listJobs(): JobManifest[] {
  ensureDataDir();
  let entries: string[];
  try {
    entries = readdirSync(jobsDir());
  } catch {
    return [];
  }

  return entries
    .map((id) => getJob(id)?.manifest)
    .filter((manifest): manifest is JobManifest => Boolean(manifest))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Two account names are the same account when the scraper's own matcher says
 * so, which is what makes "Shoppping Dil Se" and "ShopppingDilSe" one history
 * rather than two.
 */
export function sameAccount(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return sellerNamesMatch(left, right);
}

export interface AccountSummary {
  name: string;
  uploads: number;
  lastUploadAt: string;
}

/**
 * The accounts that have uploads, newest first.
 *
 * Derived from the job folders rather than kept in a separate registry — one
 * fewer file to keep in step, and deleting the last batch for an account
 * removes the account with it.
 */
export function listAccounts(): AccountSummary[] {
  const accounts: AccountSummary[] = [];

  for (const manifest of listJobs()) {
    const name = manifest.accountName?.trim();
    if (!name) continue;

    const uploadedAt = manifest.uploadTime ?? manifest.createdAt;
    const existing = accounts.find((account) => sameAccount(account.name, name));

    if (existing) {
      existing.uploads += 1;
      if (uploadedAt > existing.lastUploadAt) existing.lastUploadAt = uploadedAt;
      continue;
    }

    accounts.push({ name, uploads: 1, lastUploadAt: uploadedAt });
  }

  return accounts.sort((a, b) => b.lastUploadAt.localeCompare(a.lastUploadAt));
}

export function deleteJob(jobId: string): boolean {
  const dir = jobDir(jobId);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  cache.delete(jobId);
  return true;
}

/* --------------------------------------------------------------- mutation */

/** Patch the manifest on disk and in the index. The one place job.json is edited. */
export function updateManifest(jobId: string, patch: Partial<JobManifest>): JobManifest | null {
  const record = getJob(jobId);
  if (!record) return null;

  record.manifest = { ...record.manifest, ...patch };
  writeManifest(record.manifest);
  return record.manifest;
}

export function setJobState(jobId: string, state: JobState, extra: Partial<JobManifest> = {}): JobManifest | null {
  return updateManifest(jobId, { ...extra, state });
}

export function updateJobOptions(jobId: string, options: JobOptions): JobManifest | null {
  return setJobState(jobId, getJob(jobId)?.manifest.state ?? 'queued', { options });
}

/**
 * Persist one finished product, then update the index.
 *
 * Journal first, always: if the process dies between the two, the row is still
 * on disk and the next hydration picks it up. The reverse order would report
 * progress the disk cannot back up.
 */
export function recordResult(jobId: string, result: ScrapeResult): JobRow | null {
  const record = getJob(jobId);
  if (!record) return null;

  const stamped: JournalRow = { ...result, finishedAt: new Date().toISOString() };
  appendJournal(jobPaths.journal(jobId), stamped);

  const row = record.byKey.get(resultKey(stamped));
  if (!row) return null;

  row.status = statusForResult(stamped);
  row.result = stamped;
  row.durationMs = stamped.durationMs;
  row.attempts = stamped.attempts;
  row.message = stamped.message;
  row.screenshotPath = stamped.screenshotPath;
  row.finishedAt = stamped.finishedAt;
  return row;
}

/** Transient status for the row currently being worked, or reset on pause/stop. */
export function setRowStatus(jobId: string, index: number, status: RowStatus): JobRow | null {
  const row = getJob(jobId)?.rows[index];
  if (!row) return null;
  row.status = status;
  return row;
}

/** Clear any lingering `running` marker — used when a run ends for any reason. */
export function clearTransientRowStatuses(jobId: string): void {
  const record = getJob(jobId);
  if (!record) return;
  for (const row of record.rows) {
    if (row.status === 'running' || row.status === 'paused') {
      row.status = row.result ? statusForResult(row.result) : 'pending';
    }
  }
}

/* ----------------------------------------------------------------- queries */

export function getRows(jobId: string): JobRow[] {
  return getJob(jobId)?.rows ?? [];
}

/**
 * The orders report this batch was uploaded with, or null when it had none.
 *
 * Read from disk on demand rather than cached with the row index: it is only
 * touched when recommendations are generated, and a stale copy of it would
 * silently re-date "the last 24 hours".
 */
export function getOrdersReport(jobId: string): OrdersReport | null {
  const path = jobPaths.orders(jobId);
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, 'utf8')) as OrdersReport;
  } catch {
    // A torn file must read as "no orders report", never as "no orders" — the
    // difference is a price cut on an FSN nobody measured.
    return null;
  }
}

/**
 * Inputs still needing a scrape, in queue order.
 *
 * This is the resume rule, and it is the scraper's own: a row is done when the
 * journal holds a result under its `resultKey`. Completed products are never
 * re-scraped.
 */
export function pendingInputs(jobId: string): ScrapeInput[] {
  const record = getJob(jobId);
  if (!record) return [];
  return record.rows.filter((row) => !row.result).map((row) => record.inputs[row.index]);
}

/**
 * Drop BLOCKED rows so a resumed run retries them, healing the journal file in
 * the same step. Mirrors what `--resume` does on the CLI, via the same helper.
 */
export function prepareForRun(jobId: string): number {
  const record = getJob(jobId);
  if (!record) return 0;

  const { done, retrying } = loadResumableJournal(jobPaths.journal(jobId));

  cache.set(jobId, buildRecord(record.manifest, record.inputs, done as JournalRow[]));
  return retrying;
}

/**
 * Send finished rows back to the queue.
 *
 * A row is "done" precisely because the journal holds a result for it, so
 * retrying means removing those lines and rewriting the file. The rewrite is
 * the same healing write the resume path uses, which is why a retry survives a
 * crash halfway through it: the file is replaced atomically enough that the
 * next hydration sees either the old set or the new one.
 */
export function requeueRows(jobId: string, indexes: number[]): number {
  const record = getJob(jobId);
  if (!record) return 0;

  const targets = new Set(indexes);
  const dropped = new Set(
    record.rows.filter((row) => targets.has(row.index) && row.result).map((row) => row.key),
  );
  if (dropped.size === 0) return 0;

  const kept = readJournal(jobPaths.journal(jobId)).filter((row) => !dropped.has(resultKey(row)));
  rewriteJournal(jobPaths.journal(jobId), kept);

  cache.set(jobId, buildRecord(record.manifest, record.inputs, kept as JournalRow[]));
  return dropped.size;
}

export function computeStats(jobId: string): JobStats {
  const record = getJob(jobId);
  if (!record) {
    return {
      total: 0,
      pending: 0,
      running: 0,
      completed: 0,
      succeeded: 0,
      failed: 0,
      successRate: null,
      averageMs: null,
      estimatedRemainingMs: null,
      queueLength: 0,
    };
  }

  const rows = record.rows;
  const succeeded = rows.filter((row) => row.status === 'success').length;
  const failed = rows.filter((row) => row.status === 'failed').length;
  const running = rows.filter((row) => row.status === 'running').length;
  const completed = succeeded + failed;
  const pending = rows.length - completed - running;

  const timed = rows.filter((row) => typeof row.durationMs === 'number');
  const averageMs = timed.length
    ? Math.round(timed.reduce((sum, row) => sum + (row.durationMs ?? 0), 0) / timed.length)
    : null;

  // The throttle between products is real wall-clock time; leaving it out makes
  // a 1000-item estimate hours too optimistic.
  const perProductMs =
    averageMs === null ? null : averageMs + record.manifest.options.delayMs + record.manifest.options.delayJitterMs / 2;

  return {
    total: rows.length,
    pending,
    running,
    completed,
    succeeded,
    failed,
    successRate: completed ? Math.round((succeeded / completed) * 1000) / 10 : null,
    averageMs,
    estimatedRemainingMs: perProductMs === null ? null : Math.round(perProductMs * (pending + running)),
    queueLength: pending,
  };
}

/** Drop a cached index so the next read comes from disk. Used by crash recovery. */
export function invalidate(jobId: string): void {
  cache.delete(jobId);
}
