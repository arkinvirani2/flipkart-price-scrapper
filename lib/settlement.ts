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

import { sellerNamesMatch } from '@/scraper/parser';
import type { JobRow } from '@/types/dashboard';

/** Which of the settlement lists a row belongs in. */
export type SettlementCategory = 'main' | 'below' | 'equal' | 'review';

export interface Settlement {
  /** The page's "current" price — the scraper's mainPrice. */
  currentPrice: number | null;
  sellerPrice: number | null;
  /** currentPrice − sellerPrice. Null when either price is missing. */
  difference: number | null;
  /** (difference / sellerPrice) × 100. Null when sellerPrice is missing or zero. */
  differencePct: number | null;
  /**
   * Do we hold the buy box — is the winning seller our own seller?
   * Null when the page never told us who is winning, which is not the same as No.
   */
  hasBuybox: boolean | null;
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

  // Compared through the scraper's own name matcher, so "Shoppping Dil Se" and
  // "ShopppingDilSe" are the same seller here as they are during a scrape.
  const buyboxSellerName = row.result?.buyboxSellerName ?? null;
  const hasBuybox = buyboxSellerName ? sellerNamesMatch(buyboxSellerName, row.targetSeller) : null;

  const { category, reason } = categorize(row, {
    currentPrice,
    sellerPrice,
    difference,
    currentBankSettlement,
    bankSettlementThreshold,
    finalBankSettlement,
  });

  return {
    currentPrice,
    sellerPrice,
    difference,
    differencePct,
    hasBuybox,
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
    difference: number | null;
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
  // A zero difference is neither above nor below the threshold — the prices match,
  // so it gets its own list and is kept out of the main and below-threshold ones.
  if (parts.difference === 0) {
    return { category: 'equal', reason: null };
  }
  if (parts.currentBankSettlement === null || parts.bankSettlementThreshold === null) {
    return { category: 'review', reason: 'Missing bank-settlement values' };
  }
  // finalBankSettlement is guaranteed non-null once both inputs above exist.
  const passes = (parts.finalBankSettlement as number) >= parts.bankSettlementThreshold;
  
  return { category: passes ? 'main' : 'below', reason: null };
}

/* ------------------------------------------- candidate price -> settlement */

/**
 * The settlement a candidate listing price would produce.
 *
 * This is the one direction the maths is allowed to run, and it is stated here
 * as a function so nothing has to re-derive it:
 *
 *     settlement(P) = currentBankSettlement + (P − myPrice)
 *
 * A rupee on the price is a rupee on the settlement — Flipkart's fees do not
 * move when the price does. Feeding `currentPrice` in reproduces
 * `finalBankSettlement` exactly, which is what keeps this screen and the
 * recommendation screen from ever disagreeing.
 *
 * Null when the settlement values are missing: an unknown settlement must never
 * be mistaken for an affordable one.
 */
export function settlementAtPrice(settlement: Settlement, candidatePrice: number | null): number | null {
  const { sellerPrice, currentBankSettlement } = settlement;
  if (candidatePrice === null || sellerPrice === null || currentBankSettlement === null) return null;
  return currentBankSettlement + (candidatePrice - sellerPrice);
}

/** A candidate listing price, judged against the minimum allowed settlement. */
export interface CandidateVerdict {
  /** The listing price being judged. */
  price: number;
  /** What it would settle at. Null when the settlement values are missing. */
  settlement: number | null;
  /** The minimum this SKU is allowed to settle at. */
  minimumSettlement: number | null;
  /**
   * True only when the settlement is known *and* clears the minimum.
   *
   * Unprovable is not safe. A missing threshold means we cannot say the price is
   * affordable, and recommending it anyway is exactly the mistake this type
   * exists to make impossible.
   */
  safe: boolean;
  /** Why it failed, for the audit trail. Null when safe. */
  unsafeReason: string | null;
}

/**
 * Judge a candidate listing price the way the pricing brief requires:
 * calculate its settlement, then compare that settlement with the minimum.
 *
 * Deliberately *not* a comparison of the candidate against a price threshold.
 * The two are algebraically the same thing here — settlement is linear in price
 * with slope 1, so `settlement(P) >= minimum` and `P >= floor` agree exactly —
 * but only one of them reads the way the business rule is written, and only one
 * of them survives a future where fees stop being price-independent.
 */
export function judgeCandidatePrice(settlement: Settlement, candidatePrice: number | null): CandidateVerdict | null {
  if (candidatePrice === null) return null;

  const projected = settlementAtPrice(settlement, candidatePrice);
  const minimum = settlement.bankSettlementThreshold;

  if (candidatePrice <= 0) {
    return { price: candidatePrice, settlement: projected, minimumSettlement: minimum, safe: false, unsafeReason: 'The candidate price is not a real price.' };
  }
  if (projected === null || minimum === null) {
    return {
      price: candidatePrice,
      settlement: projected,
      minimumSettlement: minimum,
      safe: false,
      unsafeReason: 'The bank-settlement values are missing, so this price cannot be proved safe.',
    };
  }
  if (projected < minimum) {
    return {
      price: candidatePrice,
      settlement: projected,
      minimumSettlement: minimum,
      safe: false,
      unsafeReason: `It would settle at ₹${projected.toLocaleString('en-IN')}, below the ₹${minimum.toLocaleString('en-IN')} minimum.`,
    };
  }
  return { price: candidatePrice, settlement: projected, minimumSettlement: minimum, safe: true, unsafeReason: null };
}

export const SETTLEMENT_CATEGORY_LABEL: Record<SettlementCategory, string> = {
  main: 'Main',
  below: 'Below threshold',
  equal: 'No difference',
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
