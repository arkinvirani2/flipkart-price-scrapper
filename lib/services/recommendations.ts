/**
 * Generating, saving and reading a job's recommendations.
 *
 * The work is a straight join of the three uploaded sheets onto the scrape:
 *
 *   Sheet 1 (listing)    → your listing price, current bank settlement, benchmark
 *   Sheet 2 (settlement) → minimum bank settlement
 *   Sheet 3 (orders)     → orders in the last 24 hours, per FSN
 *
 * All three already arrive on the job's rows and orders report at upload time,
 * so nothing is re-read from a spreadsheet here. The rows are turned into
 * records, the records are classified tab by tab, and the result is written once
 * to `data/jobs/<jobId>/recommendations.json`.
 *
 * Opening an old upload reads that file back verbatim — a classification is a
 * decision made at a point in time, and re-deriving it later against newer data
 * would quietly rewrite what the user acted on. Regenerating is a button.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { computeSettlement } from '@/lib/settlement';
import {
  buildRecord,
  classify,
  countRecommendations,
  summarizeRecommendations,
  type Recommendation,
} from '@/lib/recommendation';
import { demandFor } from '@/lib/demand';
import { getJob, getOrdersReport, updateManifest } from '@/lib/store/jobStore';
import { jobPaths } from '@/lib/store/paths';
import type { JobRow, OrdersWindow, RecommendationCounts } from '@/types/dashboard';

/**
 * The shape of recommendations.json.
 *
 * Bumped when the record or the tab set changes, so a file written by an older
 * build is regenerated rather than rendered into tabs that no longer exist.
 */
export const RECOMMENDATION_SCHEMA = 2;

export interface RecommendationFile {
  schema: number;
  jobId: string;
  jobName: string;
  /** Our seller — the Flipkart account this upload belongs to. */
  accountName: string;
  uploadTime: string;
  generatedAt: string;
  /** What the orders report covered, or null when the batch had none. */
  ordersWindow: OrdersWindow | null;
  counts: RecommendationCounts;
  summary: string;
  recommendations: Recommendation[];
}

/**
 * Build and classify a job's records, and write the result to its folder.
 *
 * Called when a run ends, and on first view of a job that has no saved file.
 * Returns null only when the job itself is missing.
 */
export function generateRecommendations(jobId: string): RecommendationFile | null {
  const record = getJob(jobId);
  if (!record) return null;

  const accountName = record.manifest.accountName?.trim() || record.inputs[0]?.targetSeller || '';

  // The orders report is per-batch and read once. A batch without one leaves the
  // order count unknown, which is a different thing from an FSN that sold
  // nothing — `demandFor` already returns a zeroed record for the latter.
  const orders = getOrdersReport(jobId);

  const records = record.rows.map((row: JobRow) =>
    buildRecord(
      row,
      computeSettlement(row),
      row.targetSeller || accountName,
      orders ? demandFor(orders, row.fsn) : null,
    ),
  );

  const recommendations = classify(records);
  const counts = countRecommendations(recommendations);
  const summary = summarizeRecommendations(counts);
  const generatedAt = new Date().toISOString();

  const file: RecommendationFile = {
    schema: RECOMMENDATION_SCHEMA,
    jobId,
    jobName: record.manifest.name,
    accountName,
    uploadTime: record.manifest.uploadTime ?? record.manifest.createdAt,
    generatedAt,
    ordersWindow: record.manifest.ordersWindow ?? null,
    counts,
    summary,
    recommendations,
  };

  writeFileSync(jobPaths.recommendations(jobId), JSON.stringify(file, null, 2), 'utf8');

  // Mirrored onto the manifest so the batches list can show an upload's outcome
  // without opening the recommendations file for every row on screen.
  updateManifest(jobId, {
    recommendationCounts: counts,
    recommendationSummary: summary,
    recommendationsGeneratedAt: generatedAt,
  });

  return file;
}

/** The saved recommendations, or null when the job has none yet. */
export function loadRecommendations(jobId: string): RecommendationFile | null {
  const path = jobPaths.recommendations(jobId);
  if (!existsSync(path)) return null;

  try {
    const file = JSON.parse(readFileSync(path, 'utf8')) as RecommendationFile;
    // A file from an older build describes tabs that no longer exist. Reading it
    // back would render empty lists rather than fail, which is the worse answer.
    return file.schema === RECOMMENDATION_SCHEMA ? file : null;
  } catch {
    // A torn file is not worth crashing the page over — regenerate instead.
    return null;
  }
}

/**
 * What the recommendation page reads: the saved file if there is one, otherwise
 * generate it once. Viewing history therefore never re-decides anything.
 */
export function ensureRecommendations(jobId: string): RecommendationFile | null {
  return loadRecommendations(jobId) ?? generateRecommendations(jobId);
}
