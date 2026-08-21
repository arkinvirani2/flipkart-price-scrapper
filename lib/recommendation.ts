/**
 * The recommendation classification.
 *
 * Pure and dependency-free, exactly like `lib/settlement.ts`, so the same code
 * decides a record on the server (when a run finishes and the result is written
 * to the job folder) and can be re-read in the browser without a second
 * implementation drifting away from it.
 *
 * There are no pricing rules here and none are wanted. A record is a set of
 * figures, and the eight tabs are eight filters applied *in order*: the first
 * tab whose filter a record passes owns it, and no later tab ever sees it again.
 * That sequence is the whole algorithm — see `classify` below, which is written
 * tab by tab so it can be read against the specification line for line.
 *
 * The figures themselves are stated once, in `buildRecord`:
 *
 *     Difference           = Winner Price      − Flipkart Display Our Price
 *     Benchmark difference = Benchmark Price   − Flipkart Display Our Price
 *     Fees                 = Your Listing Price − Current Bank Settlement
 *
 * `Your Listing Price` (the sheet's own figure) and `Flipkart Display Our Price`
 * (what the page actually shows a buyer) are different numbers and are never
 * read as each other.
 */

import type { Settlement } from '@/lib/settlement';
import type { FsnDemand } from '@/lib/demand';
import type { JobRow, RecommendationCounts } from '@/types/dashboard';

/* -------------------------------------------------------------- categories */

/**
 * The eight tabs, in the order they are evaluated.
 *
 * The order is the specification: `CATEGORY_ORDER` below is what `classify`
 * walks, and the UI lists the tabs from the same constant, so the two can never
 * disagree about which filter comes first.
 */
export type RecommendationCategory =
  | 'priceChangeDiff'
  | 'priceChangeBenchmark'
  | 'alreadyCorrect'
  | 'settlementUnsafe'
  | 'buyboxWonGetOrder'
  | 'buyboxWonNoOrderMultiSeller'
  | 'buyboxWonNoOrderSingleSeller'
  | 'needsReview';

export const CATEGORY_ORDER: readonly RecommendationCategory[] = [
  'priceChangeDiff',
  'priceChangeBenchmark',
  'alreadyCorrect',
  'settlementUnsafe',
  'buyboxWonGetOrder',
  'buyboxWonNoOrderMultiSeller',
  'buyboxWonNoOrderSingleSeller',
  'needsReview',
];

export const RECOMMENDATION_CATEGORY_LABEL: Record<RecommendationCategory, string> = {
  priceChangeDiff: 'Price change (Diff)',
  priceChangeBenchmark: 'Price Change (Set Benchmark Price)',
  alreadyCorrect: 'already correct',
  settlementUnsafe: 'settlement unsafe (Set minimum bank settlement)',
  buyboxWonGetOrder: 'buy box won (get order)',
  buyboxWonNoOrderMultiSeller: 'buy box won (no order, more than one seller)',
  buyboxWonNoOrderSingleSeller: 'buy box won (no order, only one seller)',
  needsReview: 'Needs review',
};

/* -------------------------------------------------------------- the record */

export interface Recommendation {
  /** Queue position in the job, so the record can be traced back to its row. */
  index: number;
  /** `resultKey` of the row — stable across reloads, used as the React key. */
  key: string;
  sku: string;
  fsn: string;
  /** Our seller — the account this upload belongs to. */
  seller: string;
  productUrl: string;

  /** Sheet 1, "Your Selling Price". The price the seller edits in Seller Hub. */
  listingPrice: number | null;
  /** Scraped: the price Flipkart currently shows a buyer for *our* listing. */
  flipkartDisplayPrice: number | null;
  /** Scraped: the price the order goes to — the Buy Box price. */
  winnerPrice: number | null;
  /** Scraped: who holds the Buy Box. */
  winnerSeller: string | null;
  /**
   * Do we hold the Buy Box? The existing calculation, straight off
   * `computeSettlement` — null means Flipkart named no winning seller, which is
   * not the same as losing it.
   */
  hasBuybox: boolean | null;
  /** Sheet 1, "Benchmark Price". */
  benchmarkPrice: number | null;
  /** Sheet 1, "Bank Settlement". */
  currentSettlement: number | null;
  /** Sheet 2, "Minimum Bank Settlement price". */
  minSettlement: number | null;

  /** Winner Price − Flipkart Display Our Price. */
  difference: number | null;
  /** Benchmark Price − Flipkart Display Our Price. */
  benchmarkDifference: number | null;
  /** Your Listing Price − Current Bank Settlement. */
  fees: number | null;
  /** Units ordered for this FSN in the last 24 hours (Sheet 3). Null with no report. */
  orderCount: number | null;
  /**
   * How many sellers the listing has, us included. Null when the scrape never
   * reported one — an absent count is not a count of one.
   */
  sellerCount: number | null;

  /** True when this row was never scraped or came back with a failure status. */
  scrapeFailed: boolean;
  /** The scrape status, for the Needs review tab. */
  scrapeStatus: string | null;
  /** The scraper's own message for a failed row. */
  scrapeMessage: string | null;

  /**
   * The listing price the owning tab expects, and the settlement that goes with
   * it. Only tabs 1, 2, 4 and 6 define these; on every other tab they are null,
   * because that tab's specification lists no such column.
   */
  expectedListingPrice: number | null;
  expectedBankSettlement: number | null;

  /**
   * The tab that owns this record, or null when no tab's filter matched it —
   * which is the honest answer for a row whose Buy Box was never determined, or
   * whose seller count or order count is unknown. Inventing a home for it would
   * be a rule, and there are no rules here.
   */
  category: RecommendationCategory | null;
}

/* ----------------------------------------------------------- the figures */

/** True only when every argument is a real number. */
function known(...values: (number | null)[]): boolean {
  return values.every((value) => value !== null && Number.isFinite(value));
}

/**
 * Assemble one record's figures from its row.
 *
 * `settlement` is the existing settlement calculation for the same row — passed
 * in rather than recomputed, so the Buy Box answer and the two scraped prices
 * are the same ones the settlement view shows.
 */
export function buildRecord(
  row: JobRow,
  settlement: Settlement,
  seller: string,
  demand: FsnDemand | null,
): Recommendation {
  const listingPrice = row.listingPrice ?? null;
  const flipkartDisplayPrice = settlement.sellerPrice;
  const winnerPrice = settlement.currentPrice;
  const benchmarkPrice = row.benchmarkPrice ?? null;
  const currentSettlement = settlement.currentBankSettlement;
  const minSettlement = settlement.bankSettlementThreshold;

  // The scrape counts every seller on the listing, ours included, so this is the
  // "how many sellers are in this listing" figure tabs 6 and 7 ask for.
  const sellerCount = row.result?.sellersScanned ?? null;
  const scrapeFailed = !row.result || row.result.status !== 'OK';

  return {
    index: row.index,
    key: row.key,
    sku: row.sku,
    fsn: row.fsn,
    seller,
    productUrl: row.productUrl,

    listingPrice,
    flipkartDisplayPrice,
    winnerPrice,
    winnerSeller: row.result?.buyboxSellerName ?? null,
    hasBuybox: settlement.hasBuybox,
    benchmarkPrice,
    currentSettlement,
    minSettlement,

    difference: known(winnerPrice, flipkartDisplayPrice)
      ? (winnerPrice as number) - (flipkartDisplayPrice as number)
      : null,
    benchmarkDifference: known(benchmarkPrice, flipkartDisplayPrice)
      ? (benchmarkPrice as number) - (flipkartDisplayPrice as number)
      : null,
    fees: known(listingPrice, currentSettlement)
      ? (listingPrice as number) - (currentSettlement as number)
      : null,
    // No orders report at all is unknown, not zero. An FSN the report simply
    // never mentions did sell nothing, and `demandFor` already returns a zeroed
    // record for that case rather than null.
    orderCount: demand === null ? null : demand.last24hUnits,
    sellerCount,

    scrapeFailed,
    scrapeStatus: row.result?.status ?? null,
    scrapeMessage: row.result?.message ?? null,

    expectedListingPrice: null,
    expectedBankSettlement: null,

    category: null,
  };
}

/* --------------------------------------------------------- classification */

/** What a tab's filter decides about one record. */
interface TabVerdict {
  /** Does this record belong to the tab? */
  matches: boolean;
  /** The tab's Expected listing price, when the tab defines one. */
  expectedListingPrice?: number | null;
  /** The tab's Expected bank settlement, when the tab defines one. */
  expectedBankSettlement?: number | null;
}

const NO: TabVerdict = { matches: false };

const lostBuybox = (item: Recommendation) => item.hasBuybox === false;
const wonBuybox = (item: Recommendation) => item.hasBuybox === true;

/**
 * The eight filters, in order.
 *
 * Each one is written exactly as its tab is specified and reads only the figures
 * that tab names. Nothing here consults an earlier or later tab — the ordering
 * lives in `classify`, and it is the only thing that makes them exclusive.
 */
const TAB_FILTERS: Record<RecommendationCategory, (item: Recommendation) => TabVerdict> = {
  /* 1. Price change (Diff)
   *    Buy Box lost, and current bank settlement + difference > minimum. */
  priceChangeDiff: (item) => {
    if (!lostBuybox(item)) return NO;
    if (!known(item.currentSettlement, item.difference, item.minSettlement)) return NO;

    const expectedBankSettlement = (item.currentSettlement as number) + (item.difference as number);
    if (!(expectedBankSettlement > (item.minSettlement as number))) return NO;

    return {
      matches: true,
      expectedListingPrice: known(item.listingPrice)
        ? (item.listingPrice as number) + (item.difference as number)
        : null,
      expectedBankSettlement,
    };
  },

  /* 2. Price Change (Set Benchmark Price)
   *    Buy Box lost, and current bank settlement + benchmark difference > minimum. */
  priceChangeBenchmark: (item) => {
    if (!lostBuybox(item)) return NO;
    if (!known(item.currentSettlement, item.benchmarkDifference, item.minSettlement)) return NO;

    const expectedBankSettlement =
      (item.currentSettlement as number) + (item.benchmarkDifference as number);
    if (!(expectedBankSettlement > (item.minSettlement as number))) return NO;

    return {
      matches: true,
      expectedListingPrice: item.benchmarkPrice,
      expectedBankSettlement,
    };
  },

  /* 3. already correct
   *    Buy Box lost, and we are already showing the winner price. */
  alreadyCorrect: (item) => {
    if (!lostBuybox(item)) return NO;
    if (!known(item.flipkartDisplayPrice, item.winnerPrice)) return NO;
    return { matches: item.flipkartDisplayPrice === item.winnerPrice };
  },

  /* 4. settlement unsafe (Set minimum bank settlement)
   *    Every remaining Buy Box loss. Priced at the floor. */
  settlementUnsafe: (item) => {
    if (!lostBuybox(item)) return NO;
    return {
      matches: true,
      expectedListingPrice: known(item.minSettlement, item.fees)
        ? (item.minSettlement as number) + (item.fees as number)
        : null,
      expectedBankSettlement: item.minSettlement,
    };
  },

  /* 5. buy box won (get order) — held, and it sold. */
  buyboxWonGetOrder: (item) => {
    if (!wonBuybox(item)) return NO;
    if (item.orderCount === null) return NO;
    return { matches: item.orderCount > 0 };
  },

  /* 6. buy box won (no order, more than one seller)
   *    Held, sold nothing, and there are competitors. The benchmark is taken
   *    when it still clears the minimum settlement, and the floor when it does
   *    not — the one conditional the specification asks for. */
  buyboxWonNoOrderMultiSeller: (item) => {
    if (!wonBuybox(item)) return NO;
    if (item.orderCount !== 0) return NO;
    if (item.sellerCount === null || !(item.sellerCount > 1)) return NO;

    const benchmarkSettlement = known(item.benchmarkDifference, item.currentSettlement)
      ? (item.benchmarkDifference as number) + (item.currentSettlement as number)
      : null;
    const benchmarkClears =
      benchmarkSettlement !== null &&
      known(item.minSettlement) &&
      benchmarkSettlement > (item.minSettlement as number);

    if (benchmarkClears) {
      return {
        matches: true,
        expectedListingPrice: item.benchmarkPrice,
        expectedBankSettlement: benchmarkSettlement,
      };
    }

    return {
      matches: true,
      expectedListingPrice: known(item.minSettlement, item.fees)
        ? (item.minSettlement as number) + (item.fees as number)
        : null,
      expectedBankSettlement: item.minSettlement,
    };
  },

  /* 7. buy box won (no order, only one seller) — held, sold nothing, sole seller. */
  buyboxWonNoOrderSingleSeller: (item) => {
    if (!wonBuybox(item)) return NO;
    if (item.orderCount !== 0) return NO;
    return { matches: item.sellerCount === 1 };
  },

  /* 8. Needs review — the scrape failed, so there is nothing to judge. */
  needsReview: (item) => ({ matches: item.scrapeFailed }),
};

/**
 * Assign every record to at most one tab.
 *
 * Written as the specification describes it: tab 1 takes what it wants from the
 * whole set, tab 2 evaluates only what tab 1 left, and so on to tab 8. A record
 * that no filter claims keeps `category: null` and appears on no tab.
 *
 * The records are returned as new objects rather than mutated, so a caller
 * cannot end up half-classified if this ever throws.
 */
export function classify(records: Recommendation[]): Recommendation[] {
  const assigned = new Map<number, Recommendation>();
  let remaining = records;

  for (const category of CATEGORY_ORDER) {
    const filter = TAB_FILTERS[category];
    const left: Recommendation[] = [];

    for (const item of remaining) {
      const verdict = filter(item);
      if (!verdict.matches) {
        left.push(item);
        continue;
      }

      assigned.set(item.index, {
        ...item,
        category,
        expectedListingPrice: verdict.expectedListingPrice ?? null,
        expectedBankSettlement: verdict.expectedBankSettlement ?? null,
      });
    }

    remaining = left;
  }

  // Original order, with the unclaimed records left exactly as they came in.
  return records.map((item) => assigned.get(item.index) ?? item);
}

/* -------------------------------------------------------------- reporting */

export function countRecommendations(list: Recommendation[]): RecommendationCounts {
  const counts: RecommendationCounts = {
    total: list.length,
    priceChangeDiff: 0,
    priceChangeBenchmark: 0,
    alreadyCorrect: 0,
    settlementUnsafe: 0,
    buyboxWonGetOrder: 0,
    buyboxWonNoOrderMultiSeller: 0,
    buyboxWonNoOrderSingleSeller: 0,
    needsReview: 0,
    unclassified: 0,
  };

  for (const item of list) {
    if (item.category === null) counts.unclassified += 1;
    else counts[item.category] += 1;
  }

  return counts;
}

export function summarizeRecommendations(counts: RecommendationCounts): string {
  const parts = CATEGORY_ORDER.filter((category) => counts[category] > 0).map(
    (category) => `${counts[category]} ${RECOMMENDATION_CATEGORY_LABEL[category].toLowerCase()}`,
  );

  if (counts.unclassified > 0) parts.push(`${counts.unclassified} unclassified`);
  if (parts.length === 0) return `${counts.total} SKUs — nothing classified.`;

  return `${counts.total} SKUs — ${parts.join(', ')}.`;
}
