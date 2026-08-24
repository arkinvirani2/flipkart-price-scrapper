/** The only recommendation calculation used by the application. */

import type { JobRow } from '@/types/dashboard';

export type RecommendationStatus = 'Safe' | 'Not Safe' | 'Safe but more than 20%' | null;

export interface Recommendation {
  key: string;
  fsn: string;
  diffAmount: number | null;
  status: RecommendationStatus;
}

/**
 * A listing already owned by the account is not price-compared. Otherwise,
 * Diff Amount is my account's Flipkart price minus the main listing price.
 */
export function buildRecommendation(row: JobRow): Recommendation {
  const result = row.result;
  if (!result || result.status !== 'OK' || result.mainListingIsAccountSeller) {
    return { key: row.key, fsn: row.fsn, diffAmount: null, status: null };
  }
  if (result.sellerPrice === null || result.difference === null) {
    return { key: row.key, fsn: row.fsn, diffAmount: null, status: null };
  }

  const diffAmount = result.difference;
  if (
    row.currentBankSettlement !== undefined &&
    row.bankSettlementThreshold !== undefined &&
    !(row.currentBankSettlement + diffAmount > row.bankSettlementThreshold)
  ) {
    return { key: row.key, fsn: row.fsn, diffAmount, status: 'Not Safe' };
  }
  if (Math.abs(diffAmount) > result.sellerPrice * 0.2) {
    return { key: row.key, fsn: row.fsn, diffAmount, status: 'Safe but more than 20%' };
  }
  return { key: row.key, fsn: row.fsn, diffAmount, status: 'Safe' };
}
