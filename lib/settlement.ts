/**
 * Bank-settlement maths for the dashboard.
 *
 * The scraper's journal is left exactly as it was written — it still stores
 * `difference` as sellerPrice − mainPrice. The settlement view instead works in
 * the business-facing direction (currentPrice − sellerPrice), recomputed here
 * from the raw prices so the sign is never in doubt and the scraper stays
 * untouched.
 *
 * Pure and dependency-free on purpose: this runs both in the browser (the
 * settlement tab, the queue's diff cell) and on the server (the export builder).
 */

import type { JobRow } from '@/types/dashboard';

/** Which of the three settlement lists a row belongs in. */
export type SettlementCategory = 'main' | 'below' | 'review';

export interface Settlement {
  /** The page's "current" price — the scraper's mainPrice. */
  currentPrice: number | null;
  sellerPrice: number | null;
  /** currentPrice − sellerPrice. Null when either price is missing. */
  difference: number | null;
  /** (difference / sellerPrice) × 100. Null when sellerPrice is missing or zero. */
  differencePct: number | null;
  currentBankSettlement: number | null;
  bankSettlementThreshold: number | null;
  /** currentBankSettlement + difference. Null when either input is missing. */
  finalBankSettlement: number | null;
  category: SettlementCategory;
  /** Why a row landed in "Needs review". Null for the main/below lists. */
  reason: string | null;
}

export function computeSettlement(row: JobRow): Settlement {
  const currentPrice = row.result?.mainPrice ?? null;
  const sellerPrice = row.result?.sellerPrice ?? null;
  const currentBankSettlement = row.currentBankSettlement ?? null;
  const bankSettlementThreshold = row.bankSettlementThreshold ?? null;

  const difference = currentPrice !== null && sellerPrice !== null ? currentPrice - sellerPrice : null;
  const differencePct =
    difference !== null && sellerPrice !== null && sellerPrice !== 0 ? (difference / sellerPrice) * 100 : null;
  const finalBankSettlement =
    currentBankSettlement !== null && difference !== null ? currentBankSettlement + difference : null;

  const { category, reason } = categorize(row, {
    currentPrice,
    sellerPrice,
    currentBankSettlement,
    bankSettlementThreshold,
    finalBankSettlement,
  });

  return {
    currentPrice,
    sellerPrice,
    difference,
    differencePct,
    currentBankSettlement,
    bankSettlementThreshold,
    finalBankSettlement,
    category,
    reason,
  };
}

function categorize(
  row: JobRow,
  parts: {
    currentPrice: number | null;
    sellerPrice: number | null;
    currentBankSettlement: number | null;
    bankSettlementThreshold: number | null;
    finalBankSettlement: number | null;
  },
): { category: SettlementCategory; reason: string | null } {
  if (!row.result) {
    return { category: 'review', reason: row.status === 'running' ? 'Currently scraping' : 'Not yet scraped' };
  }
  if (row.result.status !== 'OK') {
    return { category: 'review', reason: `Scrape failed (${row.result.status})` };
  }
  if (parts.currentPrice === null || parts.sellerPrice === null) {
    return { category: 'review', reason: 'Missing price data' };
  }
  if (parts.currentBankSettlement === null || parts.bankSettlementThreshold === null) {
    return { category: 'review', reason: 'Missing bank-settlement values' };
  }
  // finalBankSettlement is guaranteed non-null once both inputs above exist.
  const passes = (parts.finalBankSettlement as number) >= parts.bankSettlementThreshold;
  return { category: passes ? 'main' : 'below', reason: null };
}

export const SETTLEMENT_CATEGORY_LABEL: Record<SettlementCategory, string> = {
  main: 'Main',
  below: 'Below threshold',
  review: 'Needs review',
};

/**
 * The Flipkart Seller Hub listing-management deep link for an FSN. Opening this
 * drops the user straight onto the row they were looking at.
 */
export function sellerListingUrl(fsn: string): string {
  return `https://seller.flipkart.com/index.html#dashboard/listings-management?listingState=ACTIVE&listingsSearchQuery=${encodeURIComponent(
    fsn,
  )}&partnerContext=ALL`;
}
