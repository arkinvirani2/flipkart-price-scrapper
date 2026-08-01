/**
 * The pricing recommendation rules.
 *
 * Pure and dependency-free, exactly like `lib/settlement.ts`, so the same
 * function decides a recommendation on the server (when a run finishes and the
 * result is written to the job folder) and can be re-run in the browser without
 * a second implementation drifting away from it.
 *
 * The rules are numbered because the user specified them that way, and the
 * number is carried on every recommendation: when someone asks "why is this
 * price here?", the answer is a rule id and a sentence, not a guess.
 *
 * The maths all hangs off one identity, borrowed from the settlement view:
 *
 *     settlement(P) = currentBankSettlement + (P − myPrice)
 *
 * i.e. a rupee off the price is a rupee off the settlement. Setting P to the
 * page's headline price reproduces `finalBankSettlement` exactly, which is why
 * the two screens can never disagree about whether a price is affordable.
 */

import type { Settlement } from '@/lib/settlement';
import type { RankedPredictor } from '@/lib/intelligence/types';
import type { JobRow, RecommendationCounts } from '@/types/dashboard';

/* -------------------------------------------------------------- categories */

export type RecommendationCategory =
  | 'priceChange'
  | 'alreadyCorrect'
  | 'settlementUnsafe'
  | 'buyboxWon'
  /**
   * Not in the original four tabs, and deliberately added: a row that was never
   * scraped, failed, or came back without prices cannot be given a
   * recommendation, and silently filing it under one of the other four would
   * misreport it. It surfaces as its own tab only when it is non-empty.
   */
  | 'needsReview';

export const RECOMMENDATION_CATEGORY_LABEL: Record<RecommendationCategory, string> = {
  priceChange: 'Price change',
  alreadyCorrect: 'Already correct',
  settlementUnsafe: 'Settlement unsafe',
  buyboxWon: 'Buy Box won',
  needsReview: 'Needs review',
};

export type RuleId =
  | 'RULE_1'
  | 'RULE_2'
  | 'RULE_3'
  | 'RULE_4'
  | 'RULE_5'
  | 'RULE_6'
  | 'RULE_7'
  | 'RULE_8'
  | 'RULE_9'
  | 'RULE_10'
  /** The per-FSN champion predictor set the price — see lib/intelligence. */
  | 'LEARNED'
  | 'NO_DATA';

export const RULE_LABEL: Record<RuleId, string> = {
  RULE_1: 'Rule 1 — Buy Box already won',
  RULE_2: 'Rule 2 — never below minimum settlement',
  RULE_3: 'Rule 3 — already matching the winner price',
  RULE_4: 'Rule 4 — match the winner price',
  RULE_5: 'Rule 5 — winner is dearer, keep the current price',
  RULE_6: 'Rule 6 — prefer a historically proven winning price',
  RULE_7: 'Rule 7 — undercut by ₹1 after five uploads without the Buy Box',
  RULE_8: 'Rule 8 — recommendation equals the current price',
  RULE_9: 'Rule 9 — never recommend a loss-making price',
  RULE_10: 'Rule 10 — no history, current upload only',
  LEARNED: 'Learned — this FSN’s best-performing predictor',
  NO_DATA: 'No usable scrape data',
};

/* ----------------------------------------------------------------- history */

/** One previous appearance of an FSN, in one previous upload for this account. */
export interface RecommendationHistoryEntry {
  jobId: string;
  jobName: string;
  /** The previous upload's time, so the UI can order and label it. */
  uploadTime: string;
  myPrice: number | null;
  winnerPrice: number | null;
  winningSeller: string | null;
  hasBuybox: boolean | null;
}

/** What the rules actually need to know about an FSN's past. */
export interface RecommendationHistorySummary {
  /** Previous uploads of this account that contained this FSN. */
  uploads: number;
  /** Newest first. Capped — the rules only look at the recent tail. */
  entries: RecommendationHistoryEntry[];
  buyboxWins: number;
  /** True when the most recent five uploads all explicitly failed to win the Buy Box. */
  lastFiveWithoutBuybox: boolean;
  /** The winning price seen most often, when it was seen more than once. */
  repeatedWinningPrice: number | null;
  repeatedWinningPriceCount: number;
}

export const EMPTY_HISTORY: RecommendationHistorySummary = {
  uploads: 0,
  entries: [],
  buyboxWins: 0,
  lastFiveWithoutBuybox: false,
  repeatedWinningPrice: null,
  repeatedWinningPriceCount: 0,
};

/** How many past appearances of one FSN are kept. Enough for rule 7 plus context. */
const HISTORY_LIMIT = 10;

/**
 * Fold an FSN's past appearances into the summary the rules read.
 *
 * `entries` must already be newest-upload-first — the caller sorts the job
 * folders, and "the last 5 uploads" means nothing without that order.
 */
export function summarizeHistory(entries: RecommendationHistoryEntry[]): RecommendationHistorySummary {
  if (entries.length === 0) return EMPTY_HISTORY;

  const kept = entries.slice(0, HISTORY_LIMIT);
  const buyboxWins = entries.filter((entry) => entry.hasBuybox === true).length;

  // Read strictly: five uploads of evidence, not "everything we have so far".
  // Undercutting the winner is the most aggressive move the rules make, and one
  // or two lost uploads is not yet a pattern. A null buybox means the page never
  // named a winner, which is not evidence of losing either.
  const lastFive = entries.slice(0, 5);
  const lastFiveWithoutBuybox =
    lastFive.length === 5 && lastFive.every((entry) => entry.hasBuybox === false);

  // Rule 6's "won multiple times": how often each winning price shows up. Ties
  // break towards the more recent price, because `entries` is newest-first and
  // the first key inserted at a given count wins the comparison below.
  const frequency = new Map<number, number>();
  for (const entry of entries) {
    if (entry.winnerPrice === null) continue;
    frequency.set(entry.winnerPrice, (frequency.get(entry.winnerPrice) ?? 0) + 1);
  }

  let repeatedWinningPrice: number | null = null;
  let repeatedWinningPriceCount = 0;
  for (const [price, count] of frequency) {
    if (count >= 2 && count > repeatedWinningPriceCount) {
      repeatedWinningPrice = price;
      repeatedWinningPriceCount = count;
    }
  }

  return {
    uploads: entries.length,
    entries: kept,
    buyboxWins,
    lastFiveWithoutBuybox,
    repeatedWinningPrice,
    repeatedWinningPriceCount,
  };
}

/* --------------------------------------------------------- recommendation */

export interface Recommendation {
  /** Queue position in the job, so the recommendation can be traced back to its row. */
  index: number;
  /** `resultKey` of the row — stable across reloads, used as the React key. */
  key: string;
  sku: string;
  fsn: string;
  accountName: string;
  productUrl: string;

  /** My listing price as scraped. */
  currentPrice: number | null;
  /** The price Flipkart headlines — the Buy Box price. */
  winnerPrice: number | null;
  winningSeller: string | null;
  /** Null whenever no change is being recommended. */
  recommendedPrice: number | null;
  /** recommendedPrice − currentPrice. Null without a recommendation. */
  priceDelta: number | null;

  currentSettlement: number | null;
  minSettlement: number | null;
  /** The settlement the recommended price would produce. Null without one. */
  projectedSettlement: number | null;

  hasBuybox: boolean | null;
  category: RecommendationCategory;
  /** The rule that decided the outcome. */
  rule: RuleId;
  /** Every rule that took part, including the deciding one. */
  appliedRules: RuleId[];
  reason: string;
  history: RecommendationHistorySummary;
  /** Present once the FSN has enough scored predictions to rank its rules. */
  learned?: LearnedMeta;
}

/** What the learning engine contributed to a recommendation, for display and audit. */
export interface LearnedMeta {
  championId: string;
  championLabel: string;
  championKind: 'rule' | 'formula';
  /** The champion's raw prediction of the next winning price. */
  predictedWinnerPrice: number | null;
  confidence: number;
  accuracyPct: number | null;
  averageError: number | null;
  timesUsed: number;
  lastUsedAt: string | null;
  formula?: string;
  /** Whether the champion actually set the price, or only advised. */
  applied: boolean;
  ranking: RankedPredictor[];
}

/** A learned target, carrying the metadata that explains where it came from. */
export interface LearnedChoice extends TargetChoice {
  meta: LearnedMeta;
}

/** Money the way the rest of the dashboard writes it, for the reason sentences. */
function money(value: number): string {
  return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/** A chosen price, before the settlement gate has had its say. */
export interface TargetChoice {
  target: number;
  rule: RuleId;
  appliedRules: RuleId[];
  reason: string;
}

/**
 * Rules 4, 6 and 7: what price to aim at once the winner is known to undercut us.
 *
 * Extracted so the learning engine can score this policy as one predictor among
 * many without a second copy of it existing anywhere.
 */
export function staticRuleTarget(
  myPrice: number,
  winnerPrice: number,
  history: RecommendationHistorySummary,
): TargetChoice {
  const appliedRules: RuleId[] = ['RULE_4'];
  let target = winnerPrice;
  let rule: RuleId = 'RULE_4';
  let reason = `Winner is ${money(myPrice - winnerPrice)} below my price — matching ${money(
    winnerPrice,
  )} takes the Buy Box.`;

  // Rule 6 — a price that has proved it wins. Only worth preferring when it
  // still undercuts today's winner: a proven price above the current winning
  // price would not win anything now.
  if (history.repeatedWinningPrice !== null && history.repeatedWinningPrice <= target) {
    target = history.repeatedWinningPrice;
    rule = 'RULE_6';
    appliedRules.push('RULE_6');
    reason = `${money(target)} has been the winning price on ${history.repeatedWinningPriceCount} previous uploads — preferring that proven price.`;
  }

  // Rule 7 — five uploads without the Buy Box.
  if (history.lastFiveWithoutBuybox && winnerPrice - 1 < target) {
    target = winnerPrice - 1;
    rule = 'RULE_7';
    appliedRules.push('RULE_7');
    reason = `The last ${Math.min(5, history.uploads)} uploads never won the Buy Box — undercutting the winner by ₹1 at ${money(
      target,
    )}.`;
  } else if (history.lastFiveWithoutBuybox) {
    // Rule 6 already went lower; rule 7 still shaped the decision, so record it.
    appliedRules.push('RULE_7');
  }

  return { target, rule, appliedRules, reason };
}

/**
 * Apply the rules to one scraped row.
 *
 * `settlement` is the existing settlement calculation for the same row — passed
 * in rather than recomputed so the recommendation and the settlement view are
 * reading identical numbers, including the buy-box match.
 */
export function recommendForRow(
  row: JobRow,
  settlement: Settlement,
  history: RecommendationHistorySummary,
  /**
   * The learning engine's verdict, when this FSN has earned one. It replaces
   * rules 4/6/7 — the *target price* — and nothing else: rules 1, 3 and 5 still
   * decide whether a change is wanted at all, and rules 2 and 9 still hold the
   * veto. A learned price can never be a loss-making price.
   */
  learned?: LearnedChoice,
): Recommendation {
  const myPrice = settlement.sellerPrice;
  const winnerPrice = settlement.currentPrice;
  const currentSettlement = settlement.currentBankSettlement;
  const minSettlement = settlement.bankSettlementThreshold;

  const base = {
    index: row.index,
    key: row.key,
    sku: row.sku,
    fsn: row.fsn,
    accountName: row.targetSeller,
    productUrl: row.productUrl,
    currentPrice: myPrice,
    winnerPrice,
    winningSeller: row.result?.buyboxSellerName ?? null,
    recommendedPrice: null as number | null,
    priceDelta: null as number | null,
    currentSettlement,
    minSettlement,
    projectedSettlement: null as number | null,
    hasBuybox: settlement.hasBuybox,
    history,
    // Carried on every outcome, not just the ones the champion priced: the
    // ranking is worth seeing even on a row that needed no change.
    learned: learned?.meta,
  };

  /* ---- rows that cannot be judged at all -------------------------------- */

  if (!row.result) {
    return {
      ...base,
      category: 'needsReview',
      rule: 'NO_DATA',
      appliedRules: ['NO_DATA'],
      reason: row.status === 'running' ? 'Currently being scraped.' : 'Not scraped yet.',
    };
  }
  if (row.result.status !== 'OK') {
    return {
      ...base,
      category: 'needsReview',
      rule: 'NO_DATA',
      appliedRules: ['NO_DATA'],
      reason: `Scrape failed (${row.result.status}) — no prices to work from.`,
    };
  }
  if (myPrice === null || winnerPrice === null) {
    return {
      ...base,
      category: 'needsReview',
      rule: 'NO_DATA',
      appliedRules: ['NO_DATA'],
      reason: 'The scrape did not return both my price and the winner price.',
    };
  }

  // Rule 10 is not a branch of its own: with no history, rules 6 and 7 simply
  // never fire and the decision is made from this upload alone. It is recorded
  // so the detail view can say so out loud.
  const applied: RuleId[] = history.uploads === 0 ? ['RULE_10'] : [];

  /* ---- rule 1: already winning ------------------------------------------ */

  if (settlement.hasBuybox === true) {
    return {
      ...base,
      category: 'buyboxWon',
      rule: 'RULE_1',
      appliedRules: [...applied, 'RULE_1'],
      reason: 'Already winning Buy Box.',
    };
  }

  /* ---- rule 3: matching the winner already ------------------------------ */

  if (winnerPrice === myPrice) {
    return {
      ...base,
      category: 'alreadyCorrect',
      rule: 'RULE_3',
      appliedRules: [...applied, 'RULE_3'],
      reason: 'Already matching winner price.',
    };
  }

  /* ---- rule 5: the winner is dearer than us ----------------------------- */

  if (winnerPrice > myPrice) {
    return {
      ...base,
      category: 'alreadyCorrect',
      rule: 'RULE_5',
      appliedRules: [...applied, 'RULE_5'],
      reason: `Winner price ${money(winnerPrice)} is above my price ${money(
        myPrice,
      )} — keeping the current price.`,
    };
  }

  /* ---- rules 4, 6 and 7: pick a target below the winner ------------------ */

  const chosen = learned ?? staticRuleTarget(myPrice, winnerPrice, history);
  const target = chosen.target;
  const rule: RuleId = chosen.rule;
  const reason = chosen.reason;
  applied.push(...chosen.appliedRules);

  /* ---- rules 2 and 9: the price has to stay profitable ------------------ */

  if (currentSettlement === null || minSettlement === null) {
    return {
      ...base,
      category: 'settlementUnsafe',
      rule: 'RULE_2',
      appliedRules: [...applied, 'RULE_2'],
      reason:
        'Bank-settlement values are missing for this SKU, so no price can be proved safe. Fill them in and re-run.',
    };
  }

  const projected = currentSettlement + (target - myPrice);

  if (target <= 0 || projected < minSettlement) {
    return {
      ...base,
      projectedSettlement: projected,
      category: 'settlementUnsafe',
      rule: 'RULE_9',
      appliedRules: [...applied, 'RULE_2', 'RULE_9'],
      reason: `Dropping to ${money(target)} would settle at ${money(projected)}, below the minimum ${money(
        minSettlement,
      )} — not worth winning.`,
    };
  }

  /* ---- rule 8: nothing would actually change ---------------------------- */

  if (target === myPrice) {
    return {
      ...base,
      category: 'alreadyCorrect',
      rule: 'RULE_8',
      appliedRules: [...applied, 'RULE_8'],
      reason: 'The recommended price equals the current price — no recommendation.',
    };
  }

  return {
    ...base,
    recommendedPrice: target,
    priceDelta: target - myPrice,
    projectedSettlement: projected,
    category: 'priceChange',
    rule,
    appliedRules: applied,
    reason,
  };
}

/* ------------------------------------------------------------ aggregation */

export function countRecommendations(list: Recommendation[]): RecommendationCounts {
  const counts: RecommendationCounts = {
    total: list.length,
    priceChange: 0,
    alreadyCorrect: 0,
    settlementUnsafe: 0,
    buyboxWon: 0,
    needsReview: 0,
  };

  for (const item of list) counts[item.category] += 1;
  return counts;
}

/** One line for the batch list, so an upload's outcome reads without opening it. */
export function summarizeRecommendations(counts: RecommendationCounts): string {
  return `${counts.priceChange} of ${counts.total} SKUs need a price change — ${counts.alreadyCorrect} already correct, ${counts.buyboxWon} winning the Buy Box, ${counts.settlementUnsafe} settlement-unsafe${
    counts.needsReview ? `, ${counts.needsReview} need review` : ''
  }.`;
}
