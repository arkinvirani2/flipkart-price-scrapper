/** The only recommendation calculation used by the application. */

import { computeSettlement } from '@/lib/settlement';
import type { JobRow } from '@/types/dashboard';

export type RecommendationStatus =
  | 'Safe'
  | 'Not Safe'
  | 'Safe but more than 20%'
  /** No Minimum Bank Settlement for this SKU, so the row cannot be judged either way. */
  | 'Threshold Missing'
  /** Anything that could not be evaluated — never a blank cell. */
  | 'Need Review';

export interface Recommendation {
  key: string;
  fsn: string;
  diffAmount: number | null;
  status: RecommendationStatus;
  /**
   * The bank settlement the row would end on once the recommendation is acted
   * upon. Only a Safe row actually moves: it lands on the settlement view's
   * currentBankSettlement + diff, capped to a 20% move of our own price when the
   * diff is wider than that band. Every other status stays put on the current
   * bank settlement, because nothing is being recommended.
   */
  finalBankSettlement: number | null;
  /** The specific "why" behind Need Review / Threshold Missing. Null once a row is actually scored. */
  reason: string | null;
}

/** Every row is scored, so a status is never absent — see RecommendationStatus. */
function unevaluated(row: JobRow, status: RecommendationStatus, reason: string): Recommendation {
  return {
    key: row.key,
    fsn: row.fsn,
    diffAmount: null,
    status,
    finalBankSettlement: row.currentBankSettlement ?? null,
    reason,
  };
}

/**
 * Diff Amount is the change our price must absorb to match the winning offer:
 * mainPrice − sellerPrice, the same direction the settlement view and the queue
 * use. Negative means we are dearer than the buy box and must come down, which
 * is why it is *added* to the current bank settlement rather than subtracted —
 * the scraper's own `difference` is stored the other way round and must not be
 * used here.
 */
export function buildRecommendation(row: JobRow): Recommendation {
  const settlement = computeSettlement(row);
  const result = row.result;

  if (!result) {
    return unevaluated(row, 'Need Review', settlement.reason ?? 'Not yet scraped');
  }
  if (result.status !== 'OK') {
    return unevaluated(row, 'Need Review', settlement.reason ?? `Scrape failed (${result.status})`);
  }
  // We already hold the main listing, so there is no competing price to move to.
  if (result.mainListingIsAccountSeller) {
    return unevaluated(row, 'Need Review', 'Account already holds the main listing');
  }
  if (settlement.sellerPrice === null || settlement.difference === null) {
    return unevaluated(row, 'Need Review', 'Missing price data');
  }

  const diffAmount = settlement.difference;

  // A missing minimum is not a pass: it is an unanswerable question, and gets
  // its own status so it can never be mistaken for a cleared row.
  if (settlement.bankSettlementThreshold === null || !Number.isFinite(settlement.bankSettlementThreshold)) {
    return {
      key: row.key,
      fsn: row.fsn,
      diffAmount,
      status: 'Threshold Missing',
      finalBankSettlement: settlement.currentBankSettlement,
      reason: 'No Minimum Bank Settlement for this SKU',
    };
  }
  if (settlement.currentBankSettlement === null || settlement.finalBankSettlement === null) {
    return unevaluated(row, 'Need Review', 'Missing current bank settlement');
  }

  // Strictly greater, everywhere: a settlement that only equals the minimum has
  // no headroom and is not safe.
  if (!(settlement.finalBankSettlement > settlement.bankSettlementThreshold)) {
    return {
      key: row.key,
      fsn: row.fsn,
      diffAmount,
      status: 'Not Safe',
      finalBankSettlement: settlement.currentBankSettlement,
      reason: null,
    };
  }
  if (Math.abs(diffAmount) > settlement.sellerPrice * 0.2) {
    // The move is capped at the 20% band, kept in the diff's own direction:
    // cheaper than the buy box lifts the settlement, dearer pulls it down.
    const cappedMove = Math.sign(diffAmount) * settlement.sellerPrice * 0.2;
    return {
      key: row.key,
      fsn: row.fsn,
      diffAmount,
      status: 'Safe but more than 20%',
      finalBankSettlement: settlement.currentBankSettlement + cappedMove,
      reason: null,
    };
  }
  return {
    key: row.key,
    fsn: row.fsn,
    diffAmount,
    status: 'Safe',
    finalBankSettlement: settlement.finalBankSettlement,
    reason: null,
  };
}
