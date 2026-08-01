/**
 * Generating, saving and reading a job's recommendations.
 *
 * There is no database and none is wanted: an account's history *is* the set of
 * job folders on disk. This module scans them, keeps only the ones belonging to
 * the same Flipkart account, and hands each FSN's past to the rule engine.
 *
 * The result is written once, to `data/jobs/<jobId>/recommendations.json`, when
 * a run ends. Opening an old upload reads that file back verbatim — a
 * recommendation is a decision made at a point in time, and re-deriving it later
 * against a newer history would quietly rewrite what the user acted on.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { computeSettlement, type Settlement } from '@/lib/settlement';
import {
  countRecommendations,
  recommendForRow,
  staticRuleTarget,
  summarizeHistory,
  summarizeRecommendations,
  EMPTY_HISTORY,
  type LearnedChoice,
  type LearnedMeta,
  type Recommendation,
  type RecommendationHistoryEntry,
  type RecommendationHistorySummary,
} from '@/lib/recommendation';
import type { UploadDecision } from '@/lib/intelligence/engine';
import { syncAccount } from '@/lib/intelligence/store';
import { getJob, getRows, listJobs, sameAccount, updateManifest } from '@/lib/store/jobStore';
import { jobPaths } from '@/lib/store/paths';
import type { JobRow, RecommendationCounts } from '@/types/dashboard';

/** The shape of recommendations.json. */
export interface RecommendationFile {
  jobId: string;
  jobName: string;
  accountName: string;
  uploadTime: string;
  generatedAt: string;
  /** How many previous uploads of this account were read to build the history. */
  historyJobs: number;
  counts: RecommendationCounts;
  summary: string;
  recommendations: Recommendation[];
}

/* ------------------------------------------------------------- the history */

/**
 * Every previous appearance of every FSN, for one account, newest upload first.
 *
 * This is the account isolation boundary: a job whose `accountName` does not
 * match is never opened, so an Anuttar upload cannot see a Previx price.
 */
function historyByFsn(accountName: string, excludeJobId: string): Map<string, RecommendationHistoryEntry[]> {
  const index = new Map<string, RecommendationHistoryEntry[]>();

  // listJobs is already newest-first by createdAt; sorting explicitly on the
  // upload time keeps that true even for jobs whose manifest predates the field.
  const previous = listJobs()
    .filter((manifest) => manifest.id !== excludeJobId && sameAccount(manifest.accountName, accountName))
    .sort((left, right) =>
      (right.uploadTime ?? right.createdAt).localeCompare(left.uploadTime ?? left.createdAt),
    );

  for (const manifest of previous) {
    const uploadTime = manifest.uploadTime ?? manifest.createdAt;

    for (const row of getRows(manifest.id)) {
      // Only scraped rows are evidence. A pending or failed row says nothing
      // about who was winning, and counting it as a loss would trip rule 7.
      if (!row.result || row.result.status !== 'OK') continue;

      const settlement = computeSettlement(row);
      const entry: RecommendationHistoryEntry = {
        jobId: manifest.id,
        jobName: manifest.name,
        uploadTime,
        myPrice: settlement.sellerPrice,
        winnerPrice: settlement.currentPrice,
        winningSeller: row.result.buyboxSellerName ?? null,
        hasBuybox: settlement.hasBuybox,
      };

      const existing = index.get(row.fsn);
      if (existing) existing.push(entry);
      else index.set(row.fsn, [entry]);
    }
  }

  return index;
}

/* ------------------------------------------------------------- the learner */

/**
 * Translate a champion's forecast into a target price the rule engine can use.
 *
 * Two guards are not negotiable. The champion is only allowed to set the price
 * once it is `trusted` — enough scored predictions, and a confidence that
 * survives the small-sample correction — so a formula fitted to five points
 * cannot start moving real prices on a hunch. And its forecast is clamped to at
 * most the current winning price, because a price above today's winner would not
 * win the Buy Box however well it predicts next week's board.
 *
 * Everything downstream is unchanged: the settlement floor still vetoes, and a
 * row that needed no change still needs none.
 */
function learnedChoice(
  decision: UploadDecision | undefined,
  settlement: Settlement,
  history: RecommendationHistorySummary,
): LearnedChoice | undefined {
  if (!decision) return undefined;

  const meta: LearnedMeta = {
    championId: decision.championId ?? 'rule:engine',
    championLabel: decision.championLabel,
    championKind: decision.championKind,
    predictedWinnerPrice: decision.predictedWinnerPrice,
    confidence: decision.confidence,
    accuracyPct: decision.accuracyPct,
    averageError: decision.averageError,
    timesUsed: decision.timesUsed,
    lastUsedAt: decision.lastUsedAt,
    formula: decision.formula,
    applied: false,
    ranking: decision.ranking,
  };

  const myPrice = settlement.sellerPrice;
  const winnerPrice = settlement.currentPrice;

  // Not trusted, or nothing to say: the champion still reports its ranking, but
  // rules 4/6/7 keep the pen.
  if (
    !decision.trusted ||
    decision.predictedWinnerPrice === null ||
    myPrice === null ||
    winnerPrice === null ||
    winnerPrice >= myPrice
  ) {
    return {
      ...staticRuleTarget(myPrice ?? 0, winnerPrice ?? 0, history),
      meta,
    };
  }

  const target = Math.max(1, Math.min(decision.predictedWinnerPrice, winnerPrice));

  return {
    target,
    rule: 'LEARNED',
    appliedRules: ['RULE_4', 'LEARNED'],
    reason: `${decision.championLabel} is this FSN's best predictor (${decision.reason}) and forecasts the next winning price at ₹${decision.predictedWinnerPrice.toLocaleString(
      'en-IN',
    )} — pricing at ₹${target.toLocaleString('en-IN')}.`,
    meta: { ...meta, applied: true },
  };
}

/* ---------------------------------------------------------- generate/read */

/**
 * Run the rules over a job and write the result to its folder.
 *
 * Called when a run ends, and on first view of a job that finished before this
 * feature existed. Returns null only when the job itself is missing.
 */
export function generateRecommendations(jobId: string): RecommendationFile | null {
  const record = getJob(jobId);
  if (!record) return null;

  const accountName = record.manifest.accountName?.trim() || record.inputs[0]?.targetSeller || '';
  const history = accountName ? historyByFsn(accountName, jobId) : new Map<string, RecommendationHistoryEntry[]>();
  const historyJobs = new Set<string>();

  // Bring this account's per-FSN intelligence up to date first: it replays any
  // upload it has not folded in yet, in chronological order, and returns what
  // each FSN's best-performing predictor says for this one.
  const learned = accountName ? syncAccount(accountName).decisions.get(jobId) : undefined;

  const recommendations = record.rows.map((row: JobRow) => {
    const entries = history.get(row.fsn);
    for (const entry of entries ?? []) historyJobs.add(entry.jobId);

    const settlement = computeSettlement(row);
    const summary = entries ? summarizeHistory(entries) : EMPTY_HISTORY;

    return recommendForRow(
      row,
      settlement,
      summary,
      learnedChoice(learned?.get(row.fsn), settlement, summary),
    );
  });

  const counts = countRecommendations(recommendations);
  const summary = summarizeRecommendations(counts);
  const generatedAt = new Date().toISOString();

  const file: RecommendationFile = {
    jobId,
    jobName: record.manifest.name,
    accountName,
    uploadTime: record.manifest.uploadTime ?? record.manifest.createdAt,
    generatedAt,
    historyJobs: historyJobs.size,
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
    return JSON.parse(readFileSync(path, 'utf8')) as RecommendationFile;
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
