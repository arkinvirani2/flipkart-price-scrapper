/**
 * Persistence for the per-FSN intelligence.
 *
 * Same principle as the rest of this app: plain files, no database. The layout
 * is sharded because the access pattern is "read and rewrite a few hundred FSNs
 * out of possibly tens of thousands":
 *
 *   data/intelligence/<account>/manifest.json   processed jobs, shard count
 *   data/intelligence/<account>/shard-NN.json   { fsn: FsnIntelligence }
 *
 * One file per account would mean rewriting megabytes to record one upload; one
 * file per FSN would mean tens of thousands of tiny files and a directory listing
 * that takes longer than the work. Thirty-two shards keeps each file in the tens
 * of kilobytes and means an upload rewrites only the shards it actually touched.
 *
 * Everything here is derived data. If the whole directory is deleted it rebuilds
 * itself from the job folders on the next run, which is also how a corrupt shard
 * heals — there is no state here that is not reproducible from the journals.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeSettlement } from '@/lib/settlement';
import { getRows, listJobs, sameAccount } from '@/lib/store/jobStore';
import { dataDir } from '@/lib/store/paths';
import { processObservation, type UploadDecision } from './engine';
import {
  DEFAULT_INTELLIGENCE_CONFIG,
  emptyIntelligence,
  type FsnIntelligence,
  type IntelligenceConfig,
  type Observation,
} from './types';

const SHARD_COUNT = 32;
const VERSION = 1;

interface Manifest {
  version: number;
  accountName: string;
  shardCount: number;
  /** Jobs already folded in. The idempotency guard for ingestion. */
  processedJobIds: string[];
  fsnCount: number;
  updatedAt: string;
}

interface AccountStore {
  slug: string;
  accountName: string;
  manifest: Manifest;
  shards: Map<number, Record<string, FsnIntelligence>>;
  dirty: Set<number>;
  manifestDirty: boolean;
  processed: Set<string>;
}

/** Pinned to globalThis so Next's dev-mode reloading cannot hand out a second cache. */
const cache: Map<string, AccountStore> =
  ((globalThis as Record<string, unknown>).__fsnIntelligence as Map<string, AccountStore>) ??
  new Map<string, AccountStore>();
(globalThis as Record<string, unknown>).__fsnIntelligence = cache;

/* ----------------------------------------------------------------- paths */

export function intelligenceDir(): string {
  return join(dataDir(), 'intelligence');
}

/**
 * A filesystem-safe folder name for an account.
 *
 * Normalised the same way account matching is, so "Shoppping Dil Se" and
 * "ShopppingDilSe" share one store rather than quietly keeping two histories.
 */
export function accountSlug(accountName: string): string {
  const normalized = accountName.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return normalized || 'unassigned';
}

function accountPath(slug: string): string {
  return join(intelligenceDir(), slug);
}

/** FNV-1a: a tiny, stable, dependency-free hash. Shard placement must never move. */
function shardOf(fsn: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < fsn.length; i += 1) {
    hash ^= fsn.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % SHARD_COUNT;
}

/**
 * Write through a temporary file.
 *
 * A half-written shard would be unreadable JSON, and the whole point of this
 * store is that it survives the process dying mid-batch. Rename is atomic enough
 * on every filesystem this runs on: a reader sees either the old file or the new
 * one, never a torn one.
 */
function writeAtomic(path: string, contents: string): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, contents, 'utf8');
  renameSync(temporary, path);
}

/* ------------------------------------------------------------ load/save */

function loadAccount(accountName: string): AccountStore {
  const slug = accountSlug(accountName);
  const cached = cache.get(slug);
  if (cached) return cached;

  const directory = accountPath(slug);
  mkdirSync(directory, { recursive: true });

  let manifest: Manifest = {
    version: VERSION,
    accountName,
    shardCount: SHARD_COUNT,
    processedJobIds: [],
    fsnCount: 0,
    updatedAt: new Date().toISOString(),
  };

  const manifestPath = join(directory, 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
      // A shard-count change would send every FSN to a different file, so an
      // older layout is discarded and rebuilt rather than half-read.
      if (parsed.version === VERSION && parsed.shardCount === SHARD_COUNT) manifest = parsed;
    } catch {
      // Unreadable manifest: rebuild from the job folders on the next sync.
    }
  }

  const store: AccountStore = {
    slug,
    accountName,
    manifest,
    shards: new Map(),
    dirty: new Set(),
    manifestDirty: false,
    processed: new Set(manifest.processedJobIds),
  };

  cache.set(slug, store);
  return store;
}

function loadShard(store: AccountStore, index: number): Record<string, FsnIntelligence> {
  const cached = store.shards.get(index);
  if (cached) return cached;

  const path = join(accountPath(store.slug), `shard-${String(index).padStart(2, '0')}.json`);
  let shard: Record<string, FsnIntelligence> = {};

  if (existsSync(path)) {
    try {
      shard = JSON.parse(readFileSync(path, 'utf8')) as Record<string, FsnIntelligence>;
    } catch {
      // A torn shard costs this account's learning for those FSNs and nothing
      // else; it refills as uploads arrive.
      shard = {};
    }
  }

  store.shards.set(index, shard);
  return shard;
}

export function getRecord(store: AccountStore, fsn: string): FsnIntelligence {
  const index = shardOf(fsn);
  const shard = loadShard(store, index);
  const existing = shard[fsn];
  if (existing) return existing;

  const created = emptyIntelligence(fsn, store.accountName);
  shard[fsn] = created;
  store.dirty.add(index);
  return created;
}

function touch(store: AccountStore, fsn: string): void {
  store.dirty.add(shardOf(fsn));
}

/** Write only what changed. The reason an upload of 150 rows is a few small writes. */
export function flush(store: AccountStore): void {
  const directory = accountPath(store.slug);
  mkdirSync(directory, { recursive: true });

  for (const index of store.dirty) {
    const shard = store.shards.get(index);
    if (!shard) continue;
    writeAtomic(
      join(directory, `shard-${String(index).padStart(2, '0')}.json`),
      JSON.stringify(shard),
    );
  }
  store.dirty.clear();

  if (store.manifestDirty) {
    store.manifest.processedJobIds = [...store.processed];
    store.manifest.updatedAt = new Date().toISOString();
    writeAtomic(join(directory, 'manifest.json'), JSON.stringify(store.manifest, null, 2));
    store.manifestDirty = false;
  }
}

/* ---------------------------------------------------------------- ingest */

/**
 * Fold every upload this account has, in chronological order, into the store.
 *
 * Ordering is not a detail: a formula fitted on uploads 1–4 must be scored
 * against upload 5, never the reverse. Replaying out of order would produce a
 * different — and wrong — set of coefficients.
 *
 * Already-processed jobs are skipped, so this is safe to call on every run and
 * cheap when there is nothing new. On a fresh store it backfills the entire
 * history in one pass.
 */
export function syncAccount(
  accountName: string,
  config: IntelligenceConfig = DEFAULT_INTELLIGENCE_CONFIG,
): { store: AccountStore; decisions: Map<string, Map<string, UploadDecision>> } {
  const store = loadAccount(accountName);
  const decisions = new Map<string, Map<string, UploadDecision>>();

  const jobs = listJobs()
    .filter((manifest) => sameAccount(manifest.accountName, accountName))
    .sort((left, right) =>
      (left.uploadTime ?? left.createdAt).localeCompare(right.uploadTime ?? right.createdAt),
    );

  for (const manifest of jobs) {
    if (store.processed.has(manifest.id)) continue;

    const uploadTime = manifest.uploadTime ?? manifest.createdAt;
    const perFsn = new Map<string, UploadDecision>();
    // One upload can legitimately list the same FSN under two SKUs; the first
    // one wins so a single upload contributes a single observation.
    const seen = new Set<string>();

    for (const row of getRows(manifest.id)) {
      if (!row.result || row.result.status !== 'OK' || seen.has(row.fsn)) continue;

      const settlement = computeSettlement(row);
      if (settlement.sellerPrice === null || settlement.currentPrice === null) continue;
      seen.add(row.fsn);

      const observation: Observation = {
        jobId: manifest.id,
        t: uploadTime,
        myPrice: settlement.sellerPrice,
        winnerPrice: settlement.currentPrice,
        hasBuybox: settlement.hasBuybox,
        currentSettlement: settlement.currentBankSettlement,
        minSettlement: settlement.bankSettlementThreshold,
      };

      const record = getRecord(store, row.fsn);
      perFsn.set(row.fsn, processObservation(record, observation, config));
      touch(store, row.fsn);
    }

    decisions.set(manifest.id, perFsn);
    store.processed.add(manifest.id);
    store.manifestDirty = true;
  }

  store.manifest.fsnCount = countFsns(store);
  flush(store);

  return { store, decisions };
}

function countFsns(store: AccountStore): number {
  let total = 0;
  for (const shard of store.shards.values()) total += Object.keys(shard).length;
  return Math.max(total, store.manifest.fsnCount);
}

/**
 * Throw the account's learning away so the next sync rebuilds it from scratch.
 *
 * Needed whenever history changes shape underneath the store — a batch deleted,
 * rows re-scraped — because the accumulators are sums that cannot be un-added.
 */
export function resetAccount(accountName: string): void {
  const slug = accountSlug(accountName);
  cache.delete(slug);
  rmSync(accountPath(slug), { recursive: true, force: true });
}

/**
 * Forget every account's learned history.
 *
 * Counted before the tree goes so the reset can report what it actually threw
 * away — this store is the only thing in `data/` that outlives the batch that
 * produced it, so "3 accounts" is the number a user checks the result against.
 */
export function resetAllAccounts(): number {
  const directory = intelligenceDir();
  const accounts = existsSync(directory) ? readdirSync(directory).length : 0;
  cache.clear();
  rmSync(directory, { recursive: true, force: true });
  return accounts;
}

/* ---------------------------------------------------------------- reads */

export function readAccount(accountName: string): AccountStore {
  return loadAccount(accountName);
}

export function readRecord(accountName: string, fsn: string): FsnIntelligence | null {
  const store = loadAccount(accountName);
  const shard = loadShard(store, shardOf(fsn));
  return shard[fsn] ?? null;
}

/** Every FSN this account has learned about. Loads all shards, so callers page it. */
export function allRecords(accountName: string): FsnIntelligence[] {
  const store = loadAccount(accountName);
  const directory = accountPath(store.slug);
  if (!existsSync(directory)) return [];

  const records: FsnIntelligence[] = [];
  for (const file of readdirSync(directory)) {
    const match = /^shard-(\d+)\.json$/.exec(file);
    if (!match) continue;
    for (const record of Object.values(loadShard(store, Number(match[1])))) records.push(record);
  }

  return records;
}
