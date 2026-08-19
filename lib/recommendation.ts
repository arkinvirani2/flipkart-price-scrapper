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
import { emptyDemand, type FsnDemand } from '@/lib/demand';
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
  /* Rules 11–14 are the Buy Box + orders layer. They only ever fire on a row
   * that rule 1 would previously have ended, so nothing above them changed. */
  | 'RULE_11'
  | 'RULE_12'
  | 'RULE_13'
  | 'RULE_14'
  /** The per-FSN champion predictor set the price — see lib/intelligence. */
  | 'LEARNED'
  | 'NO_DATA';

export const RULE_LABEL: Record<RuleId, string> = {
  RULE_1: 'Rule 1 — Buy Box already won',
  RULE_2: 'Rule 2 — never below minimum settlement',
  RULE_3: 'Rule 3 — already matching the winner price',
  RULE_4: 'Rule 4 — match the winner price',
  RULE_5: 'Rule 5 — winner is dearer, raise to the winner price',
  RULE_6: 'Rule 6 — prefer a historically proven winning price',
  RULE_7: 'Rule 7 — undercut by ₹1 after five uploads without the Buy Box',
  RULE_8: 'Rule 8 — recommendation equals the current price',
  RULE_9: 'Rule 9 — never recommend a loss-making price',
  RULE_10: 'Rule 10 — no history, current upload only',
  RULE_11: 'Rule 11 — Buy Box with orders, or none to be had',
  RULE_12: 'Rule 12 — Buy Box with no orders, too little evidence to act',
  RULE_13: 'Rule 13 — Buy Box with no orders, benchmark or smallest useful move',
  RULE_14: 'Rule 14 — Buy Box with no orders, already at the price floor',
  LEARNED: 'Learned — this FSN’s best-performing predictor',
  NO_DATA: 'No usable scrape data',
};

/* --------------------------------------------------- benchmark and demand */

/**
 * What Flipkart's own Benchmark Price was worth on this row.
 *
 * Carried separately from `reasonCode` on purpose. The two answer different
 * questions — "was there a usable market anchor?" and "what did we do?" — and
 * collapsing them would lose the first every time a Buy Box outcome won the
 * second, which is exactly the row where knowing the benchmark was zero matters.
 */
export type BenchmarkStatus =
  /** Flipkart published no benchmark for this FSN (the cell is 0 or blank). */
  | 'BENCHMARK_ZERO'
  /** A benchmark exists but sits under the minimum acceptable price. */
  | 'BELOW_THRESHOLD'
  /** A benchmark exists and is affordable — usable as a price anchor. */
  | 'BENCHMARK_USABLE'
  /** No benchmark column in the upload at all. */
  | 'BENCHMARK_MISSING';

export const BENCHMARK_STATUS_LABEL: Record<BenchmarkStatus, string> = {
  BENCHMARK_ZERO: 'No benchmark published',
  BELOW_THRESHOLD: 'Benchmark below the minimum acceptable price',
  BENCHMARK_USABLE: 'Benchmark usable',
  BENCHMARK_MISSING: 'No benchmark column in the upload',
};

/** What the decision layer actually did, in one token. */
export type PriceReasonCode =
  | BenchmarkStatus
  /** Buy Box held and the FSN sold in the last 24h — nothing to fix. */
  | 'BUYBOX_HEALTHY'
  /** Buy Box held, nothing sold in 24h, and the evidence supports a small cut. */
  | 'BUYBOX_STALE_REDUCE'
  /** Buy Box held, nothing sold in 24h, but a quiet day is normal for this FSN. */
  | 'BUYBOX_STALE_HOLD'
  /** Buy Box held, nothing sold in 24h, and the price is already at its floor. */
  | 'BUYBOX_AT_FLOOR'
  /** Buy Box held, nothing sold in 24h, and the listing has no stock to sell. */
  | 'BUYBOX_NO_STOCK'
  /** Buy Box held, but no orders report was uploaded, so 24h activity is unknown. */
  | 'NO_ORDER_DATA'
  /** No Buy Box — the pre-existing rules decided this row. */
  | 'NORMAL'
  | 'NO_DATA';

/**
 * How strong the "Buy Box but no orders" signal is on one FSN.
 *
 * `insufficient` is the default and the only band that never moves a price.
 */
export type DemandSignal = 'insufficient' | 'weak' | 'moderate' | 'strong';

/**
 * The knobs of the Buy Box layer, in one exported object so they can be tuned
 * and asserted against rather than hunted for as literals.
 *
 * The confidence thresholds are calibrated against the Poisson zero-probability
 * below, and were chosen to land where the brief asked them to land:
 *
 *     ~10 units/day → 100% → strong    (0 orders is a real anomaly)
 *     ~3 units/day  →  95% → strong
 *     ~1–2/day      →  63–86% → weak/moderate  (a quiet day is ordinary)
 *     <0.8/day      →  <55% → insufficient     (do not touch the price)
 */
export const BUYBOX_DEMAND_TUNING = {
  /** Confidence at or above which the band applies. */
  strongConfidence: 0.95,
  moderateConfidence: 0.85,
  weakConfidence: 0.55,
  /** The largest price cut each band may authorise, as a fraction of the price. */
  strongMaxCut: 0.05,
  moderateMaxCut: 0.03,
  weakMaxCut: 0.015,
  /** A report shorter than this cannot reach full confidence on its own. */
  fullCoverageDays: 7,
  /** Below this, the change is not worth an edit in Seller Hub. */
  minimumStep: 1,
} as const;

/** The evidence behind a Buy Box + zero-orders decision, kept for the audit trail. */
export interface DemandEvidence {
  /** Units sold in the trailing 24 hours. */
  last24hUnits: number;
  /** What this FSN normally sells in a day, over the rest of the report. */
  unitsPerDay: number;
  /**
   * P(zero units in a day) if demand had not changed, as Poisson(unitsPerDay).
   * This is the whole "is zero unusual?" question in one number.
   */
  zeroProbability: number;
  /** (1 − zeroProbability), damped by how much history the report covers. 0–1. */
  confidence: number;
  signal: DemandSignal;
  /** True when the band was stepped down because we already undercut the benchmark. */
  damped: boolean;
  observedDays: number;
}

/**
 * Score a zero-order day against what the FSN normally does.
 *
 * Pure, and separated from the pricing so the judgement can be tested on its
 * own: given a rate and a window, how surprised should we be by a silent day?
 *
 * `damped` implements a rule the brief is explicit about — do not assume zero
 * orders means the price is wrong. When we are already at or under Flipkart's
 * own benchmark, price is the least likely explanation, so the band is stepped
 * down one notch and a strong signal buys a moderate cut rather than a large one.
 */
export function assessZeroOrderEvidence(
  demand: FsnDemand,
  observedDays: number,
  options: { alreadyUnderBenchmark: boolean } = { alreadyUnderBenchmark: false },
): DemandEvidence {
  const unitsPerDay = Math.max(0, demand.unitsPerDay);
  const zeroProbability = Math.exp(-unitsPerDay);

  // A two-day report cannot tell us what "normal" is, however busy those two
  // days were, so short windows can never reach the top bands on their own.
  const coverage = Math.min(1, Math.max(0, observedDays) / BUYBOX_DEMAND_TUNING.fullCoverageDays);
  const confidence = (1 - zeroProbability) * coverage;

  const bands: DemandSignal[] = ['insufficient', 'weak', 'moderate', 'strong'];
  let level = 0;
  if (confidence >= BUYBOX_DEMAND_TUNING.strongConfidence) level = 3;
  else if (confidence >= BUYBOX_DEMAND_TUNING.moderateConfidence) level = 2;
  else if (confidence >= BUYBOX_DEMAND_TUNING.weakConfidence) level = 1;

  const damped = options.alreadyUnderBenchmark && level > 0;
  if (damped) level -= 1;

  return {
    last24hUnits: demand.last24hUnits,
    unitsPerDay,
    zeroProbability,
    confidence,
    signal: bands[level],
    damped,
    observedDays,
  };
}

/** The largest cut a signal authorises, as a fraction of the current price. */
export function maxCutFor(signal: DemandSignal): number {
  switch (signal) {
    case 'strong':
      return BUYBOX_DEMAND_TUNING.strongMaxCut;
    case 'moderate':
      return BUYBOX_DEMAND_TUNING.moderateMaxCut;
    case 'weak':
      return BUYBOX_DEMAND_TUNING.weakMaxCut;
    default:
      return 0;
  }
}

/**
 * The lowest price that still settles at or above the minimum — the hard floor.
 *
 * Derived from the settlement identity the whole dashboard already runs on:
 *
 *     settlement(P) = currentBankSettlement + (P − myPrice)
 *
 * Setting settlement(P) to the threshold and solving for P gives the price
 * below which a sale stops being worth making. Expressing the threshold in
 * price terms is what lets the benchmark, the competitor price and the floor be
 * compared with each other at all.
 *
 * Null when any input is missing — and a null floor is treated downstream as
 * "no price can be proved safe", never as "no floor".
 */
export function minimumAcceptablePrice(settlement: Settlement): number | null {
  const { sellerPrice, currentBankSettlement, bankSettlementThreshold } = settlement;
  if (sellerPrice === null || currentBankSettlement === null || bankSettlementThreshold === null) {
    return null;
  }
  return sellerPrice + (bankSettlementThreshold - currentBankSettlement);
}

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
  /**
   * The sheet's own "Your Listing Price" for this SKU. Null when the upload had
   * no such column — the page price is what the rules read, so this is carried
   * purely so the expected price is quoted against the number the seller edits.
   */
  listingPrice: number | null;
  /** The price Flipkart headlines — the Buy Box price. */
  winnerPrice: number | null;
  winningSeller: string | null;
  /**
   * Winner Price − Flipkart Displayed Our Listing Price.
   *
   * The `Change` the UI shows, and the figure that is *added* to the current
   * listing price and to the current bank settlement to get the expected ones.
   * Negative when the winner undercuts us, which is the direction that makes the
   * addition move the price down towards the winner.
   *
   * Independent of whether a price change is recommended — it describes where we
   * sit against the winner, not what any rule decided. Null when either price is
   * missing.
   */
  difference: number | null;
  /** Null whenever no change is being recommended. */
  recommendedPrice: number | null;
  /** recommendedPrice − currentPrice. Null without a recommendation. */
  priceDelta: number | null;

  currentSettlement: number | null;
  minSettlement: number | null;
  /** The settlement the recommended price would produce. Null without one. */
  projectedSettlement: number | null;

  hasBuybox: boolean | null;

  /** Flipkart's system-generated Benchmark Price, straight from the listing sheet. */
  benchmarkPrice: number | null;
  /** What that benchmark was worth here — see BenchmarkStatus. Always set. */
  benchmarkStatus: BenchmarkStatus;
  /** The price floor implied by the minimum settlement. Null when unprovable. */
  minAcceptablePrice: number | null;
  /** Units sold in the last 24h. Null only when no orders report was uploaded. */
  ordersLast24h: number | null;
  /** What this FSN normally sells per day. Null without an orders report. */
  historicalUnitsPerDay: number | null;
  /** The zero-order evidence, when the Buy Box layer ran. */
  demand?: DemandEvidence;
  /**
   * How much this recommendation is trusted, 0–1.
   *
   * Only the Buy Box layer produces a graded confidence — the deterministic
   * rules either apply or do not, so they report 1 when they set a price and 0
   * when they decline to.
   */
  confidence: number;

  category: RecommendationCategory;
  /** The rule that decided the outcome. */
  rule: RuleId;
  /** Every rule that took part, including the deciding one. */
  appliedRules: RuleId[];
  /** The outcome in one token, for filtering and export. */
  reasonCode: PriceReasonCode;
  reason: string;
  history: RecommendationHistorySummary;
  /** Present once the FSN has enough scored predictions to rank its rules. */
  learned?: LearnedMeta;
}

/**
 * The listing price this recommendation starts from: the sheet's "Your Listing
 * Price" when the upload carried that column, and the scraped page price
 * otherwise, so uploads made before the column existed still show a figure.
 */
export function currentListingPrice(item: Recommendation): number | null {
  return item.listingPrice ?? item.currentPrice;
}

/**
 * The Difference: Winner Price − Flipkart Displayed Our Listing Price.
 *
 * Read through this rather than straight off the field. A saved recommendations
 * file is never re-decided on the way in, so one written by an older build
 * carries whatever that build stored — or nothing at all. Both prices are on the
 * record either way, and the Difference is only ever this subtraction of them,
 * so recomputing is both the same answer and a self-correcting one. The stored
 * field is the fallback, for the rows where a price is missing.
 */
export function priceDifference(item: Recommendation): number | null {
  if (item.currentPrice !== null && item.winnerPrice !== null) {
    return item.winnerPrice - item.currentPrice;
  }
  return item.difference ?? null;
}

/**
 * The listing price a recommendation would leave behind:
 *
 *     Expected Listing Price = Current Listing Price + Difference
 *
 * The Difference is *added*, never subtracted. Derived rather than stored, so it
 * can never drift from the Change shown beside it. Null whenever either half is
 * missing — an unknown price plus a known change is still unknown.
 */
export function expectedListingPrice(item: Recommendation): number | null {
  const listed = currentListingPrice(item);
  const difference = priceDifference(item);
  if (listed === null || difference === null) return null;
  return listed + difference;
}

/**
 * The bank settlement that goes with the expected listing price:
 *
 *     Expected Bank Settlement = Current Bank Settlement + Difference
 *
 * Added, like the price above, and for the same reason: the two "expected"
 * figures are one pair, read off the same Difference.
 *
 * Distinct from `projectedSettlement`, which answers a different question — what
 * the *recommended price* would settle at — and is what the minimum-settlement
 * gate is judged on. The two are deliberately not merged.
 */
export function expectedBankSettlement(item: Recommendation): number | null {
  const difference = priceDifference(item);
  if (item.currentSettlement === null || difference === null) return null;
  return item.currentSettlement + difference;
}

/**
 * The same expected listing price, measured from the recommendation instead of
 * from the winner:
 *
 *     Expected Listing Price = Current Listing Price + (recommended − displayed)
 *
 * For the Buy Box lists. On a row we already win, the winner *is* us, so the
 * winner-based Change is zero and tells the reader nothing. What moves the price
 * there is the recommendation — Flipkart's benchmark, or whatever the zero-order
 * rules chose — so those tabs quote their Change and expected figures against
 * `priceDelta`, and `projectedSettlement` is already the matching settlement.
 */
export function expectedListingPriceAtRecommendation(item: Recommendation): number | null {
  const listed = currentListingPrice(item);
  if (listed === null || item.priceDelta === null) return null;
  return listed + item.priceDelta;
}

/** What the Settlement unsafe list quotes in place of an unaffordable winner. */
export interface SettlementUnsafeTarget {
  /** True when the benchmark cleared the minimum-settlement check. */
  benchmarkUsable: boolean;
  /** The price standing in for the winner. Null when neither answer is derivable. */
  target: number | null;
  /** target − Flipkart displayed price. This list's Change. */
  change: number | null;
  expectedListingPrice: number | null;
  expectedBankSettlement: number | null;
}

/**
 * The Settlement unsafe list's own figures.
 *
 * These are the rows where matching the winner would settle under the minimum,
 * so the winner price is not something anyone can act on and every figure
 * derived from it would be advice to lose money. Two answers replace it:
 *
 *   Benchmark Price − Fees > Minimum Bank Settlement
 *       → the benchmark stands in as the winner price, and the Change and both
 *         expected figures are derived from it exactly as they would be from a
 *         real winner — `change` is what makes that one substitution flow
 *         through all three.
 *
 *   otherwise
 *       → the floor itself. The price is Minimum Bank Settlement + Fees, which
 *         is `minAcceptablePrice`, and it settles at exactly the Minimum Bank
 *         Settlement. Both are stated rather than derived, because the floor is
 *         defined by the settlement it lands on, not by any market price.
 *
 * The check needs the settlement values: `BENCHMARK_USABLE` on its own can also
 * mean "there was no floor to test the benchmark against", which is not the same
 * as passing the test.
 *
 * This is presentation, not a rule — the row keeps the category and the rule the
 * engine gave it, and stays on the Settlement unsafe list either way.
 */
export function settlementUnsafeTarget(item: Recommendation): SettlementUnsafeTarget {
  const benchmarkUsable =
    item.benchmarkStatus === 'BENCHMARK_USABLE' &&
    item.benchmarkPrice !== null &&
    item.benchmarkPrice > 0 &&
    item.minAcceptablePrice !== null;

  if (benchmarkUsable) {
    const target = item.benchmarkPrice as number;
    const change = item.currentPrice === null ? null : target - item.currentPrice;
    const listed = currentListingPrice(item);

    return {
      benchmarkUsable: true,
      target,
      change,
      expectedListingPrice: listed === null || change === null ? null : listed + change,
      expectedBankSettlement:
        item.currentSettlement === null || change === null ? null : item.currentSettlement + change,
    };
  }

  return {
    benchmarkUsable: false,
    target: item.minAcceptablePrice,
    change:
      item.minAcceptablePrice === null || item.currentPrice === null
        ? null
        : item.minAcceptablePrice - item.currentPrice,
    expectedListingPrice: item.minAcceptablePrice,
    expectedBankSettlement: item.minSettlement,
  };
}

/**
 * The order-side inputs to a recommendation.
 *
 * `demand` being null while `ordersAvailable` is true means the report was read
 * and this FSN was not in it — which is zero orders, not missing data. The two
 * flags exist separately so that distinction cannot be lost.
 */
export interface DemandContext {
  /** True when an orders report was uploaded for this job at all. */
  ordersAvailable: boolean;
  demand: FsnDemand | null;
  /** Days the orders report spans. */
  observedDays: number;
}

const NO_DEMAND_CONTEXT: DemandContext = { ordersAvailable: false, demand: null, observedDays: 0 };

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
 * What the normal calculation — the first three tabs' conditions — recommends.
 *
 * Null when the winner is not below us, because there is then no price to chase
 * down to; otherwise the target rules 4/6/7 chose, or the learned one that
 * replaces them. Used by the Tab 4 path, which has to ask this question without
 * the settlement values that the ordinary route would gate the answer on.
 *
 * Rule 5's raise is deliberately not offered here: Tab 4 is a row whose Buy Box
 * we already hold, so the winner is us, and there is no one to raise towards.
 */
function normalTarget(
  myPrice: number,
  winnerPrice: number,
  history: RecommendationHistorySummary,
  learned?: LearnedChoice,
): TargetChoice | null {
  if (winnerPrice >= myPrice) return null;
  return learned ?? staticRuleTarget(myPrice, winnerPrice, history);
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
  /**
   * The last 24 hours of orders for this FSN. Omitted entirely when no orders
   * report was uploaded, in which case rule 1 behaves exactly as it always did.
   */
  demandContext: DemandContext = NO_DEMAND_CONTEXT,
): Recommendation {
  const myPrice = settlement.sellerPrice;
  const winnerPrice = settlement.currentPrice;
  const currentSettlement = settlement.currentBankSettlement;
  const minSettlement = settlement.bankSettlementThreshold;

  const benchmarkPrice = row.benchmarkPrice ?? null;
  const minAcceptablePrice = minimumAcceptablePrice(settlement);
  const benchmarkStatus = classifyBenchmark(benchmarkPrice, minAcceptablePrice);
  const demand = demandContext.ordersAvailable
    ? // No rows for an FSN means it sold nothing, so a zeroed record is the
      // truthful reading — see lib/orders.
      (demandContext.demand ?? emptyDemand(row.fsn, demandContext.observedDays - 1))
    : null;

  const base = {
    index: row.index,
    key: row.key,
    sku: row.sku,
    fsn: row.fsn,
    accountName: row.targetSeller,
    productUrl: row.productUrl,
    currentPrice: myPrice,
    listingPrice: row.listingPrice ?? null,
    winnerPrice,
    winningSeller: row.result?.buyboxSellerName ?? null,
    // Winner Price − Flipkart Displayed Our Listing Price. Computed once, here,
    // so every outcome below carries the same Difference whether or not its rule
    // recommended a price.
    difference: myPrice !== null && winnerPrice !== null ? winnerPrice - myPrice : null,
    recommendedPrice: null as number | null,
    priceDelta: null as number | null,
    currentSettlement,
    minSettlement,
    projectedSettlement: null as number | null,
    hasBuybox: settlement.hasBuybox,
    benchmarkPrice,
    benchmarkStatus,
    minAcceptablePrice,
    ordersLast24h: demand?.last24hUnits ?? null,
    historicalUnitsPerDay: demand?.unitsPerDay ?? null,
    confidence: 0,
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
      reasonCode: 'NO_DATA',
      reason: row.status === 'running' ? 'Currently being scraped.' : 'Not scraped yet.',
    };
  }
  if (row.result.status !== 'OK') {
    return {
      ...base,
      category: 'needsReview',
      rule: 'NO_DATA',
      appliedRules: ['NO_DATA'],
      reasonCode: 'NO_DATA',
      reason: `Scrape failed (${row.result.status}) — no prices to work from.`,
    };
  }
  if (myPrice === null || winnerPrice === null) {
    return {
      ...base,
      category: 'needsReview',
      rule: 'NO_DATA',
      appliedRules: ['NO_DATA'],
      reasonCode: 'NO_DATA',
      reason: 'The scrape did not return both my price and the winner price.',
    };
  }

  // Rule 10 is not a branch of its own: with no history, rules 6 and 7 simply
  // never fire and the decision is made from this upload alone. It is recorded
  // so the detail view can say so out loud.
  const applied: RuleId[] = history.uploads === 0 ? ['RULE_10'] : [];

  /* ---- rule 1 + rules 11-14: already winning ---------------------------- */

  if (settlement.hasBuybox === true) {
    return decideWithBuybox({
      base,
      applied,
      myPrice,
      winnerPrice,
      history,
      learned,
      currentSettlement,
      minSettlement,
      minAcceptablePrice,
      benchmarkPrice,
      benchmarkStatus,
      stockCount: row.stockCount ?? null,
      demand,
      observedDays: demandContext.observedDays,
    });
  }

  /* ---- rule 3: matching the winner already ------------------------------ */

  if (winnerPrice === myPrice) {
    return {
      ...base,
      category: 'alreadyCorrect',
      rule: 'RULE_3',
      appliedRules: [...applied, 'RULE_3'],
      reasonCode: benchmarkStatus,
      reason: 'Already matching winner price.',
    };
  }

  /* ---- rule 5: the winner is dearer than us ----------------------------- */

  // A winner priced above us is margin left on the table: we are already the
  // cheaper offer, so the price can rise to meet theirs without becoming the
  // dearer one. That makes this a price change, not a row to tick off — its
  // Change is positive and its expected listing price sits above the current.
  //
  // No settlement gate on the way out: raising a price can only raise the
  // settlement with it, so rules 2 and 9 have nothing here to veto.
  if (winnerPrice > myPrice) {
    const projected = currentSettlement === null ? null : currentSettlement + (winnerPrice - myPrice);

    return {
      ...base,
      recommendedPrice: winnerPrice,
      priceDelta: winnerPrice - myPrice,
      projectedSettlement: projected,
      category: 'priceChange',
      rule: 'RULE_5',
      appliedRules: [...applied, 'RULE_5'],
      reasonCode: benchmarkStatus,
      // Deterministic, like the other rules that set a price outright.
      confidence: 1,
      reason: `Winner price ${money(winnerPrice)} is above my price ${money(
        myPrice,
      )} — raising to ${money(winnerPrice)} takes the margin currently being left on the table.`,
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
      reasonCode: benchmarkStatus,
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
      reasonCode: benchmarkStatus,
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
      reasonCode: benchmarkStatus,
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
    reasonCode: benchmarkStatus,
    // A deterministic rule either fires or does not; there is no half-applied
    // rule 4, so a price it sets is reported at full confidence.
    confidence: 1,
    reason,
  };
}

/* -------------------------------------------- rules 11-14: Buy Box + orders */

/** The fields the Buy Box layer reads. Grouped so the call site stays readable. */
interface BuyboxInput {
  base: Omit<Recommendation, 'category' | 'rule' | 'appliedRules' | 'reasonCode' | 'reason'>;
  applied: RuleId[];
  myPrice: number;
  /** Needed by the Tab 4 path, which re-asks the first three tabs' question. */
  winnerPrice: number;
  history: RecommendationHistorySummary;
  learned?: LearnedChoice;
  currentSettlement: number | null;
  minSettlement: number | null;
  minAcceptablePrice: number | null;
  benchmarkPrice: number | null;
  benchmarkStatus: BenchmarkStatus;
  stockCount: number | null;
  demand: FsnDemand | null;
  observedDays: number;
}

/**
 * What to do about a row we are already winning.
 *
 * This is the one behavioural change to the pre-existing rules. Rule 1 used to
 * end the story — Buy Box held, therefore the price is right — and that
 * inference is only sound while the listing is converting. Holding the Buy Box
 * on a product nobody is buying says we are the cheapest of a set of prices the
 * customer rejected, which is not the same thing as being priced correctly.
 *
 * Every path out of here still respects the settlement floor, and the default
 * on thin evidence is to change nothing. Without an orders report the function
 * returns precisely what rule 1 always returned.
 */
function decideWithBuybox(input: BuyboxInput): Recommendation {
  const {
    base,
    applied,
    myPrice,
    winnerPrice,
    history,
    learned,
    currentSettlement,
    minSettlement,
    minAcceptablePrice,
    benchmarkPrice,
    benchmarkStatus,
    stockCount,
    demand,
    observedDays,
  } = input;

  const hold = (rule: RuleId, reasonCode: PriceReasonCode, reason: string, extra?: Partial<Recommendation>) => ({
    ...base,
    ...extra,
    category: 'buyboxWon' as const,
    rule,
    appliedRules: [...applied, 'RULE_1' as RuleId, rule].filter(
      (id, index, all) => all.indexOf(id) === index,
    ),
    reasonCode,
    reason,
  });

  /* ---- no orders report: rule 1, unchanged ------------------------------ */

  if (!demand) {
    return hold(
      'RULE_1',
      'NO_ORDER_DATA',
      'Already winning Buy Box. Upload the Flipkart orders report to check it is actually converting.',
    );
  }

  /* ---- rule 11: the Buy Box is doing its job ---------------------------- */

  if (demand.last24hUnits > 0) {
    return hold(
      'RULE_11',
      'BUYBOX_HEALTHY',
      `Already winning Buy Box, and ${demand.last24hUnits} unit${
        demand.last24hUnits === 1 ? '' : 's'
      } sold in the last 24 hours — the price is working.`,
      { confidence: 1 },
    );
  }

  // Zero orders with nothing on the shelf is a stock problem wearing a pricing
  // problem's clothes. Cutting the price would not sell a unit that is not there.
  if (stockCount === 0) {
    return hold(
      'RULE_11',
      'BUYBOX_NO_STOCK',
      'Winning the Buy Box with no orders in 24 hours, but stock is zero — nothing to sell, so the price is not the problem.',
    );
  }

  /* ---- rules 12-14: zero orders, how surprising is that? ---------------- */

  const evidence = assessZeroOrderEvidence(demand, observedDays, {
    // Already at or under Flipkart's own market read: undercutting ourselves
    // further is the least likely fix, so the evidence is worth one band less.
    alreadyUnderBenchmark: benchmarkPrice !== null && benchmarkPrice > 0 && benchmarkPrice >= myPrice,
  });

  const normally =
    evidence.unitsPerDay > 0
      ? `this FSN normally sells ${evidence.unitsPerDay.toFixed(2)} units/day`
      : 'this FSN has not sold at all across the whole report';

  /* ---- the benchmark check, asked first --------------------------------- */

  // "Benchmark Price − Fees > Minimum Bank Settlement". `minAcceptablePrice` is
  // that same threshold expressed as a price — minimum bank settlement + fees —
  // so the question reduces to whether the benchmark clears it, which is exactly
  // what BENCHMARK_USABLE already records. The settlement values are required
  // alongside it: without them there is no floor, and `classifyBenchmark` cannot
  // have tested the condition at all.
  //
  // When it holds, Flipkart's own benchmark *is* the recommended price. It is
  // asked before the zero-order bands because it is a published market read
  // rather than an inference from a quiet day, so it does not need the evidence
  // to authorise it and is not capped by it.
  //
  // When it fails, nothing happens here and the existing algorithm below —
  // rules 12, 13 and 14 — decides the price exactly as it did before.
  if (
    benchmarkStatus === 'BENCHMARK_USABLE' &&
    benchmarkPrice !== null &&
    minAcceptablePrice !== null &&
    currentSettlement !== null &&
    minSettlement !== null &&
    benchmarkPrice !== myPrice
  ) {
    const projected = currentSettlement + (benchmarkPrice - myPrice);
    const cheaper = benchmarkPrice < myPrice;

    return {
      ...base,
      demand: evidence,
      // The benchmark condition either holds or does not, so this is reported at
      // full confidence like the other deterministic rules — the zero-order
      // evidence is still carried above, but it is not what decided the price.
      confidence: 1,
      recommendedPrice: benchmarkPrice,
      priceDelta: benchmarkPrice - myPrice,
      projectedSettlement: projected,
      category: 'priceChange',
      rule: 'RULE_13',
      appliedRules: [...applied, 'RULE_1', 'RULE_13', 'RULE_2'],
      reasonCode: cheaper ? 'BUYBOX_STALE_REDUCE' : 'BENCHMARK_USABLE',
      reason: `Winning the Buy Box but nothing sold in 24 hours, and ${normally}. Flipkart's benchmark of ${money(
        benchmarkPrice,
      )} still settles at ${money(projected)} against a ${money(
        minSettlement,
      )} minimum, so it is the recommended price — ${
        cheaper ? 'a cut' : 'a rise'
      } of ${money(Math.abs(benchmarkPrice - myPrice))} from ${money(myPrice)}.`,
    };
  }

  if (evidence.signal === 'insufficient') {
    return hold(
      'RULE_12',
      'BUYBOX_STALE_HOLD',
      `Winning the Buy Box with no orders in 24 hours, but ${normally} — a quiet day is unremarkable${
        evidence.damped ? ' and the price is already at or under the benchmark' : ''
      }, so the price is left alone.`,
      { demand: evidence, confidence: evidence.confidence },
    );
  }

  /* ---- tab 4: the Buy Box is ours, but the settlement values are missing -- */

  // Rule 2 keeps its veto ahead of any cut: with no floor to prove a price
  // against, no *lower* price can be proved safe, so the zero-order cut of rules
  // 13/14 is off the table here.
  //
  // What the row is not left with is a blank. The first three tabs' conditions
  // still run — rule 3 (already matching the winner), rule 5 (the winner is
  // dearer) and rules 4/6/7 (match, proven price, or undercut) — and the price
  // they produce is shown along with the winner price, so the row can be judged
  // by hand. The minimum-settlement fallback price, minimum bank settlement +
  // fees, is deliberately not offered on this path: the fees are derived from
  // the very bank-settlement values that are missing, so there is nothing to
  // derive it from.
  if (minAcceptablePrice === null || currentSettlement === null || minSettlement === null) {
    const normal = normalTarget(myPrice, winnerPrice, history, learned);

    if (normal === null) {
      return {
        ...base,
        demand: evidence,
        confidence: evidence.confidence,
        category: 'settlementUnsafe',
        rule: 'RULE_2',
        appliedRules: [...applied, 'RULE_1', 'RULE_12', 'RULE_2'],
        reasonCode: 'BUYBOX_STALE_HOLD',
        reason: `Winning the Buy Box with no orders in 24 hours (${normally}), and the winner price ${money(
          winnerPrice,
        )} is not below mine, so the normal calculation wants no change. The bank-settlement values are missing, so no lower price can be proved safe either.`,
      };
    }

    return {
      ...base,
      demand: evidence,
      confidence: evidence.confidence,
      recommendedPrice: normal.target,
      priceDelta: normal.target - myPrice,
      category: 'settlementUnsafe',
      rule: normal.rule,
      appliedRules: [...applied, 'RULE_1', 'RULE_12', ...normal.appliedRules, 'RULE_2'],
      reasonCode: 'BUYBOX_STALE_HOLD',
      reason: `Winning the Buy Box with no orders in 24 hours (${normally}). ${normal.reason} The bank-settlement values are missing, so the minimum-settlement check could not be run on that price — check it before applying.`,
    };
  }

  const target = staleTarget({
    myPrice,
    benchmarkPrice,
    benchmarkUsable: benchmarkStatus === 'BENCHMARK_USABLE',
    floor: minAcceptablePrice,
    maxCut: maxCutFor(evidence.signal),
  });

  const cut = myPrice - target;

  /* ---- rule 14: the floor already has the price ------------------------- */

  if (cut < BUYBOX_DEMAND_TUNING.minimumStep) {
    const atFloor = target <= minAcceptablePrice + 0.5;
    return hold(
      atFloor ? 'RULE_14' : 'RULE_12',
      atFloor ? 'BUYBOX_AT_FLOOR' : 'BUYBOX_STALE_HOLD',
      atFloor
        ? `Winning the Buy Box with no orders in 24 hours (${normally}), but ${money(
            myPrice,
          )} is already at the ${money(minAcceptablePrice)} floor — the price is protected, not adjustable.`
        : `Winning the Buy Box with no orders in 24 hours (${normally}), but the ${evidence.signal} signal buys less than ₹1 of movement — leaving the price alone.`,
      { demand: evidence, confidence: evidence.confidence },
    );
  }

  /* ---- rule 13: the smallest cut the evidence pays for ------------------ */

  const projected = currentSettlement + (target - myPrice);

  // Belt and braces. `staleTarget` clamps to the floor and the floor is derived
  // from the same identity, so this cannot trip — but a rounding change here
  // must fail loudly into settlementUnsafe rather than quietly under the floor.
  if (projected < minSettlement) {
    return {
      ...base,
      demand: evidence,
      confidence: evidence.confidence,
      projectedSettlement: projected,
      category: 'settlementUnsafe',
      rule: 'RULE_9',
      appliedRules: [...applied, 'RULE_1', 'RULE_13', 'RULE_2', 'RULE_9'],
      reasonCode: 'BUYBOX_AT_FLOOR',
      reason: `Dropping to ${money(target)} would settle at ${money(projected)}, below the minimum ${money(
        minSettlement,
      )} — the Buy Box is not worth defending at a loss.`,
    };
  }

  const anchor =
    benchmarkStatus === 'BENCHMARK_USABLE' && benchmarkPrice !== null && benchmarkPrice === target
      ? ` That lands exactly on Flipkart's benchmark of ${money(benchmarkPrice)}.`
      : '';

  // Without this the sentence reads "a moderate signal (100% confidence)",
  // which invites the reader to think one of the two numbers is wrong.
  const damping =
    evidence.damped && benchmarkPrice !== null
      ? ` Stepped down one band because ${money(myPrice)} is already at or under the ${money(
          benchmarkPrice,
        )} benchmark, so price is the less likely cause.`
      : '';

  return {
    ...base,
    demand: evidence,
    confidence: evidence.confidence,
    recommendedPrice: target,
    priceDelta: -cut,
    projectedSettlement: projected,
    category: 'priceChange',
    rule: 'RULE_13',
    appliedRules: [...applied, 'RULE_1', 'RULE_13', 'RULE_2'],
    reasonCode: 'BUYBOX_STALE_REDUCE',
    reason: `Winning the Buy Box but nothing sold in 24 hours, and ${normally} — a ${
      evidence.signal
    } signal (${Math.round(evidence.confidence * 100)}% confidence). Cutting ${money(cut)} (${(
      (cut / myPrice) *
      100
    ).toFixed(1)}%) to ${money(target)}, which still settles at ${money(projected)} against a ${money(
      minSettlement,
    )} minimum.${anchor}${damping}`,
  };
}

/**
 * The smallest price cut worth making, given the evidence and the floor.
 *
 * Three constraints, applied in this order, and the order is the policy:
 *
 *   1. The benchmark is the destination when it is below us and affordable —
 *      there is no reason to go past the price Flipkart itself calls competitive.
 *   2. The evidence caps the step. A weak signal cannot authorise a 5% cut
 *      however far away the benchmark is.
 *   3. The floor wins over both, always.
 *
 * Rounded up, never down: rounding a ₹152.29 target to ₹152 would spend a rupee
 * the evidence did not pay for, and "the smallest reduction that helps" means
 * erring towards the higher price every time.
 */
function staleTarget(input: {
  myPrice: number;
  benchmarkPrice: number | null;
  benchmarkUsable: boolean;
  floor: number;
  maxCut: number;
}): number {
  const { myPrice, benchmarkPrice, benchmarkUsable, floor, maxCut } = input;

  const cutCap = myPrice * (1 - maxCut);
  const chasingBenchmark = benchmarkUsable && benchmarkPrice !== null && benchmarkPrice < myPrice;
  const desired = chasingBenchmark ? Math.max(benchmarkPrice, cutCap) : cutCap;

  return Math.ceil(Math.max(desired, cutCap, floor));
}

/** Where the benchmark stands relative to the floor. Always answerable. */
function classifyBenchmark(benchmarkPrice: number | null, floor: number | null): BenchmarkStatus {
  if (benchmarkPrice === null) return 'BENCHMARK_MISSING';
  // Flipkart writes 0 when it has no market read for a listing — an absence
  // dressed as a number. Treating it as a price would recommend giving the
  // product away, so it is never a price here.
  if (benchmarkPrice <= 0) return 'BENCHMARK_ZERO';
  if (floor !== null && benchmarkPrice < floor) return 'BELOW_THRESHOLD';
  return 'BENCHMARK_USABLE';
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
