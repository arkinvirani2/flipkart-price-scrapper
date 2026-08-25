/**
 * Out-of-order completion must not move a row.
 *
 * With a worker pool the journal is written in completion order, which is not
 * upload order — at twenty workers a product can land twenty places away from
 * where it started. Everything downstream (the queue's Index column, the settlement
 * view, the recommendation export, and the row numbers a user reads back
 * against their own sheet) assumes a row keeps its uploaded position no matter
 * when its result arrives.
 *
 * These tests drive the store the way a pool does: results fed back shuffled,
 * a retry that requeues a scattered subset, and a re-run that lands them in yet
 * another order. Nothing here needs a browser, which is the point — the join is
 * pure bookkeeping and is testable as such.
 *
 * Run: npm run test:pool
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeStats, createJob, getJob, recordResult, requeueRows } from '@/lib/store/jobStore';
import { buildRecommendation } from '@/lib/recommendation';
import { DEFAULT_JOB_OPTIONS, MAX_CONCURRENCY } from '@/types/dashboard';
import type { ScrapeInput, ScrapeResult } from '@/scraper/types';

// The store reads this every time it resolves a path, so setting it before the
// first call is enough — and keeps the test off the real data directory.
const dataDir = mkdtempSync(join(tmpdir(), 'pool-test-'));
process.env.SCRAPER_DATA_DIR = dataDir;

// The ceiling itself, not a copy of it: this test exists to prove the join
// survives the widest pool the app can actually run, so raising the ceiling
// must widen the test with it rather than leave it guarding the old width.
const WORKERS = MAX_CONCURRENCY;
const COUNT = 25;

/**
 * A fixed permutation, not Math.random: a test that shuffles differently every
 * run reports a different failure every run.
 */
function scrambled(length: number, step: number): number[] {
  const order: number[] = [];
  for (let i = 0; i < length; i++) order.push((i * step) % length);
  // A stride coprime with the length visits every position exactly once; assert
  // it rather than trust it, or a silent duplicate would weaken every test below.
  assert.equal(new Set(order).size, length, `stride ${step} does not permute ${length} items`);
  return order;
}

/** Prices derived from the index, so a mis-joined result is visible as a number. */
const mainPriceFor = (index: number): number => 1000 + index;
const sellerPriceFor = (index: number): number => 900 + index;

function inputs(): ScrapeInput[] {
  return Array.from({ length: COUNT }, (_, index) => ({
    productUrl: `https://www.flipkart.com/product/p/itme?pid=FSN${index}`,
    targetSeller: 'Previx',
    sku: `SKU-${index}`,
    fsn: `FSN${index}`,
    currentBankSettlement: 100 + index,
    bankSettlementThreshold: 50 + index,
  }));
}

function resultFor(input: ScrapeInput, index: number): ScrapeResult {
  return {
    fsn: input.fsn,
    sku: input.sku,
    sellerName: 'Previx',
    buyboxSellerName: 'Someone Else',
    mainPrice: mainPriceFor(index),
    sellerPrice: sellerPriceFor(index),
    // Deliberately the scraper's own (opposite) direction, as on a real journal.
    difference: sellerPriceFor(index) - mainPriceFor(index),
    isPriceDifferent: true,
    productUrl: input.productUrl,
    status: 'OK',
  };
}

/** Every row sits where it was uploaded, holding its own result. */
function assertAligned(jobId: string, expected: ScrapeInput[], label: string): void {
  const record = getJob(jobId);
  assert.ok(record, `${label}: job missing`);

  assert.equal(record.rows.length, expected.length, `${label}: row count`);
  record.rows.forEach((row, position) => {
    assert.equal(row.index, position, `${label}: row ${position} carries index ${row.index}`);
    assert.equal(row.sku, expected[position].sku, `${label}: row ${position} sku`);
    assert.equal(row.fsn, expected[position].fsn, `${label}: row ${position} fsn`);
    assert.equal(
      row.currentBankSettlement,
      expected[position].currentBankSettlement,
      `${label}: row ${position} carries another row's bank settlement`,
    );
    if (row.result) {
      assert.equal(row.result.sku, expected[position].sku, `${label}: row ${position} holds another product's result`);
      assert.equal(row.result.mainPrice, mainPriceFor(position), `${label}: row ${position} main price`);
      assert.equal(row.result.sellerPrice, sellerPriceFor(position), `${label}: row ${position} seller price`);
    }
  });

  // The recommendations are what the export writes, so they are checked as the
  // user reads them: 1-based index against the uploaded sheet.
  const recommendations = record.rows.map(buildRecommendation);
  recommendations.forEach((item, position) => {
    assert.equal(item.index, position, `${label}: recommendation ${position} index`);
    assert.equal(item.sku, expected[position].sku, `${label}: recommendation ${position} sku`);
  });
}

/* ------------------------------------------------ shuffled completion order */
{
  const rows = inputs();
  const job = createJob('pool', rows, { ...DEFAULT_JOB_OPTIONS, concurrency: WORKERS });

  // 7 is coprime with 25: a full permutation, and one that puts neighbours far
  // apart the way twenty workers racing through a queue does.
  for (const index of scrambled(COUNT, 7)) {
    const row = recordResult(job.id, resultFor(rows[index], index));
    assert.ok(row, `result for index ${index} was not matched to a row`);
    assert.equal(row.index, index, `result for index ${index} landed on row ${row.index}`);
  }

  assertAligned(job.id, rows, 'after shuffled completion');
  const stats = computeStats(job.id);
  assert.equal(stats.succeeded, COUNT);
  assert.equal(stats.pending, 0);
}

/* --------------------------------------- retry, then a second shuffled pass */
{
  const rows = inputs();
  const job = createJob('pool-retry', rows, { ...DEFAULT_JOB_OPTIONS, concurrency: WORKERS });

  for (const index of scrambled(COUNT, 7)) recordResult(job.id, resultFor(rows[index], index));

  // A scattered subset, as "Retry all" would send after a run with holes in it.
  const retried = [3, 7, 11, 19, 24];
  assert.equal(requeueRows(job.id, retried), retried.length);

  const afterRequeue = getJob(job.id)!;
  afterRequeue.rows.forEach((row, position) => {
    const shouldBePending = retried.includes(position);
    assert.equal(
      row.status,
      shouldBePending ? 'pending' : 'success',
      `requeue moved row ${position} to ${row.status}`,
    );
    assert.equal(row.result === undefined, shouldBePending, `requeue left row ${position} inconsistent`);
    // The rows that were not retried must be untouched, values included.
    if (!shouldBePending) assert.equal(row.result!.mainPrice, mainPriceFor(position));
  });
  assertAligned(job.id, rows, 'after requeue');
  assert.equal(computeStats(job.id).pending, retried.length);

  // The resumed run finishes them in a different order again.
  for (const index of [...retried].reverse()) {
    const row = recordResult(job.id, resultFor(rows[index], index));
    assert.ok(row, `retried result for index ${index} was not matched to a row`);
    assert.equal(row.index, index, `retried result for index ${index} landed on row ${row.index}`);
  }

  assertAligned(job.id, rows, 'after retry re-run');
  assert.equal(computeStats(job.id).pending, 0);
}

/* ---------------------------------------- one SKU listed under two products */
{
  // Straight from a real upload: the same Seller SKU on two FSNs, with
  // different bank settlements. The journal keys on sku + productUrl, so these
  // must stay two rows and must not inherit each other's prices.
  const rows: ScrapeInput[] = [
    { productUrl: 'https://www.flipkart.com/product/p/itme?pid=HWTHHEZ3GDQS6Y5Y', targetSeller: 'Previx', sku: 'KH-SG-48CM-0197-14', fsn: 'HWTHHEZ3GDQS6Y5Y', currentBankSettlement: 150, bankSettlementThreshold: 103 },
    { productUrl: 'https://www.flipkart.com/product/p/itme?pid=HWTHGYBYGH457C3C', targetSeller: 'Previx', sku: 'KH-SG-48CM-0197-14', fsn: 'HWTHGYBYGH457C3C', currentBankSettlement: 145, bankSettlementThreshold: 103 },
  ];
  const job = createJob('pool-dup-sku', rows, { ...DEFAULT_JOB_OPTIONS, concurrency: WORKERS });

  const record = getJob(job.id)!;
  assert.notEqual(record.rows[0].key, record.rows[1].key, 'same-SKU rows collapsed onto one key');

  // Second one first, as two workers would.
  recordResult(job.id, resultFor(rows[1], 1));
  recordResult(job.id, resultFor(rows[0], 0));

  const after = getJob(job.id)!;
  assert.equal(after.rows[0].result!.mainPrice, mainPriceFor(0));
  assert.equal(after.rows[1].result!.mainPrice, mainPriceFor(1));
  assert.equal(after.rows[0].currentBankSettlement, 150);
  assert.equal(after.rows[1].currentBankSettlement, 145);
}

rmSync(dataDir, { recursive: true, force: true });
console.log(`Pool tests passed (${COUNT} rows, ${WORKERS}-worker ordering).`);
