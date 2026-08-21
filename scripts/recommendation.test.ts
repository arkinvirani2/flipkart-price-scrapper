/**
 * Tests for the recommendation classification.
 *
 * There is no test runner in this project and adding one would be a bigger
 * change than the feature it is here to check, so this is a plain script: it
 * runs on the `ts-node` the scraper already uses, asserts with `node:assert`,
 * and exits non-zero when anything fails.
 *
 *     npm run test:recommendation
 *
 * The cases below are the eight tabs' filters, one at a time, plus the two
 * properties the specification is emphatic about: the tabs are evaluated in
 * order, and no record may appear in more than one of them.
 */

import assert from 'node:assert/strict';
import type { FsnDemand } from '@/lib/demand';
import {
  buildRecord,
  classify,
  countRecommendations,
  CATEGORY_ORDER,
  type Recommendation,
} from '@/lib/recommendation';
import { computeSettlement } from '@/lib/settlement';
import type { JobRow } from '@/types/dashboard';

/* ------------------------------------------------------------- the fixture */

const SELLER = 'Shoppping Dil Se';

interface RowSpec {
  /** Sheet 1's "Your Selling Price". */
  listingPrice?: number;
  /** What Flipkart shows a buyer for our own listing, as scraped. */
  flipkartDisplayPrice: number | null;
  /** The Buy Box price, as scraped. */
  winnerPrice: number | null;
  /** Who Flipkart names as the winner. Our own seller means we hold the Buy Box. */
  winnerSeller?: string | null;
  /** Sheet 1's "Bank Settlement". */
  currentBankSettlement?: number;
  /** Sheet 2's "Minimum Bank Settlement price". */
  minimumBankSettlement?: number;
  benchmarkPrice?: number;
  /** Sellers on the listing, ours included. */
  sellerCount?: number;
  /** A failed scrape has no prices and no seller count. */
  failed?: boolean;
  index?: number;
}

function jobRow(spec: RowSpec): JobRow {
  const index = spec.index ?? 0;

  return {
    index,
    key: `row-${index}`,
    sku: `SKU-${index}`,
    fsn: `FSN0000000${index}`,
    targetSeller: SELLER,
    productUrl: 'https://www.flipkart.com/p/itm000',
    status: spec.failed ? 'failed' : 'success',
    listingPrice: spec.listingPrice,
    currentBankSettlement: spec.currentBankSettlement,
    bankSettlementThreshold: spec.minimumBankSettlement,
    benchmarkPrice: spec.benchmarkPrice,
    result: {
      fsn: `FSN0000000${index}`,
      sku: `SKU-${index}`,
      sellerName: spec.failed ? null : SELLER,
      buyboxSellerName: spec.winnerSeller === undefined ? 'Some Other Seller' : spec.winnerSeller,
      mainPrice: spec.winnerPrice,
      sellerPrice: spec.flipkartDisplayPrice,
      difference: null,
      isPriceDifferent: spec.flipkartDisplayPrice !== spec.winnerPrice,
      productUrl: 'https://www.flipkart.com/p/itm000',
      status: spec.failed ? 'PRODUCT_UNAVAILABLE' : 'OK',
      sellersScanned: spec.sellerCount,
    },
  };
}

/** An FSN that sold `last24hUnits` units in the report's last 24 hours. */
function demand(last24hUnits: number): FsnDemand {
  return {
    fsn: 'FSN00000000',
    last24hUnits,
    last24hOrders: last24hUnits > 0 ? 1 : 0,
    historyUnits: 0,
    historyDays: 1,
    unitsPerDay: 0,
    activeDays: 0,
    cancelledUnits: 0,
    returnedUnits: 0,
  };
}

/** One record, built and classified on its own. */
function one(spec: RowSpec, orders: FsnDemand | null = demand(0)): Recommendation {
  const row = jobRow(spec);
  return classify([buildRecord(row, computeSettlement(row), SELLER, orders)])[0];
}

/** Several records, built and classified together. */
function many(specs: Array<[RowSpec, FsnDemand | null]>): Recommendation[] {
  return classify(
    specs.map(([spec, orders], index) => {
      const row = jobRow({ ...spec, index });
      return buildRecord(row, computeSettlement(row), SELLER, orders);
    }),
  );
}

/* --------------------------------------------------------------- the cases */

const CASES: Array<[string, () => void]> = [
  /* -- the figures -------------------------------------------------------- */
  [
    'The three subtractions: difference, benchmark difference and fees',
    () => {
      const item = one({
        listingPrice: 257,
        flipkartDisplayPrice: 231,
        winnerPrice: 178,
        benchmarkPrice: 260,
        currentBankSettlement: 176,
        minimumBankSettlement: 190,
      });

      assert.equal(item.difference, 178 - 231);
      assert.equal(item.benchmarkDifference, 260 - 231);
      assert.equal(item.fees, 257 - 176);
      // The sheet's listing price and the scraped displayed price stay separate.
      assert.equal(item.listingPrice, 257);
      assert.equal(item.flipkartDisplayPrice, 231);
    },
  ],

  /* -- tab 1 -------------------------------------------------------------- */
  [
    'Tab 1 — Buy Box lost and current settlement + difference > minimum',
    () => {
      const item = one({
        listingPrice: 200,
        flipkartDisplayPrice: 210,
        winnerPrice: 205,
        currentBankSettlement: 180,
        minimumBankSettlement: 150,
      });

      assert.equal(item.category, 'priceChangeDiff');
      // Expected listing price = your listing price + difference.
      assert.equal(item.expectedListingPrice, 200 + -5);
      // Expected bank settlement = current bank settlement + difference.
      assert.equal(item.expectedBankSettlement, 180 + -5);
    },
  ],

  [
    'Tab 1 — the comparison is strict: settling exactly at the minimum does not qualify',
    () => {
      const item = one({
        listingPrice: 200,
        flipkartDisplayPrice: 210,
        winnerPrice: 205,
        currentBankSettlement: 180,
        // 180 + (−5) = 175, which is not greater than 175.
        minimumBankSettlement: 175,
        // No benchmark, so tab 2 cannot take it either.
        benchmarkPrice: 0,
      });

      assert.notEqual(item.category, 'priceChangeDiff');
    },
  ],

  /* -- tab 2 -------------------------------------------------------------- */
  [
    'Tab 2 — tab 1 fails but the benchmark difference clears the minimum',
    () => {
      const item = one({
        listingPrice: 200,
        flipkartDisplayPrice: 210,
        winnerPrice: 150,
        benchmarkPrice: 230,
        currentBankSettlement: 180,
        // Tab 1: 180 + (150 − 210) = 120, below 170. Tab 2: 180 + (230 − 210) = 200.
        minimumBankSettlement: 170,
      });

      assert.equal(item.category, 'priceChangeBenchmark');
      assert.equal(item.benchmarkDifference, 20);
      assert.equal(item.expectedListingPrice, 230);
      assert.equal(item.expectedBankSettlement, 200);
    },
  ],

  /* -- tab 3 -------------------------------------------------------------- */
  [
    'Tab 3 — Buy Box lost and we already show the winner price',
    () => {
      const item = one({
        listingPrice: 200,
        flipkartDisplayPrice: 205,
        winnerPrice: 205,
        benchmarkPrice: 190,
        currentBankSettlement: 180,
        // Tab 1: 180 + 0 = 180, not above 180. Tab 2: 180 + (190 − 205) = 165.
        minimumBankSettlement: 180,
      });

      assert.equal(item.category, 'alreadyCorrect');
      assert.equal(item.difference, 0);
      // This tab defines no expected figures.
      assert.equal(item.expectedListingPrice, null);
      assert.equal(item.expectedBankSettlement, null);
    },
  ],

  /* -- tab 4 -------------------------------------------------------------- */
  [
    'Tab 4 — every remaining Buy Box loss, priced at minimum settlement + fees',
    () => {
      const item = one({
        listingPrice: 257,
        flipkartDisplayPrice: 231,
        winnerPrice: 178,
        benchmarkPrice: 200,
        currentBankSettlement: 176,
        minimumBankSettlement: 190,
      });

      assert.equal(item.category, 'settlementUnsafe');
      // Fees = 257 − 176 = 81; expected listing price = 190 + 81.
      assert.equal(item.expectedListingPrice, 190 + 81);
      assert.equal(item.expectedBankSettlement, 190);
    },
  ],

  /* -- tab 5 -------------------------------------------------------------- */
  [
    'Tab 5 — Buy Box won and the FSN sold in the last 24 hours',
    () => {
      const item = one(
        {
          listingPrice: 200,
          flipkartDisplayPrice: 200,
          winnerPrice: 200,
          winnerSeller: SELLER,
          currentBankSettlement: 180,
          minimumBankSettlement: 150,
          sellerCount: 4,
        },
        demand(3),
      );

      assert.equal(item.category, 'buyboxWonGetOrder');
      assert.equal(item.orderCount, 3);
    },
  ],

  /* -- tab 6 -------------------------------------------------------------- */
  [
    'Tab 6 — Buy Box won, no orders, several sellers, benchmark clears the minimum',
    () => {
      const item = one(
        {
          listingPrice: 200,
          flipkartDisplayPrice: 200,
          winnerPrice: 200,
          winnerSeller: SELLER,
          benchmarkPrice: 220,
          currentBankSettlement: 180,
          minimumBankSettlement: 150,
          sellerCount: 3,
        },
        demand(0),
      );

      assert.equal(item.category, 'buyboxWonNoOrderMultiSeller');
      // 20 + 180 = 200 > 150, so the benchmark is the expected listing price.
      assert.equal(item.expectedListingPrice, 220);
      assert.equal(item.expectedBankSettlement, 200);
    },
  ],

  [
    'Tab 6 — same tab, but the benchmark does not clear: the floor is used instead',
    () => {
      const item = one(
        {
          listingPrice: 200,
          flipkartDisplayPrice: 200,
          winnerPrice: 200,
          winnerSeller: SELLER,
          benchmarkPrice: 160,
          currentBankSettlement: 180,
          // 180 + (160 − 200) = 140, which is not above 190.
          minimumBankSettlement: 190,
          sellerCount: 3,
        },
        demand(0),
      );

      assert.equal(item.category, 'buyboxWonNoOrderMultiSeller');
      // Fees = 200 − 180 = 20; expected listing price = 190 + 20.
      assert.equal(item.expectedListingPrice, 210);
      assert.equal(item.expectedBankSettlement, 190);
    },
  ],

  /* -- tab 7 -------------------------------------------------------------- */
  [
    'Tab 7 — Buy Box won, no orders, and we are the only seller',
    () => {
      const item = one(
        {
          listingPrice: 200,
          flipkartDisplayPrice: 200,
          winnerPrice: 200,
          winnerSeller: SELLER,
          benchmarkPrice: 220,
          currentBankSettlement: 180,
          minimumBankSettlement: 150,
          sellerCount: 1,
        },
        demand(0),
      );

      assert.equal(item.category, 'buyboxWonNoOrderSingleSeller');
      assert.equal(item.expectedListingPrice, null);
      assert.equal(item.expectedBankSettlement, null);
    },
  ],

  /* -- tab 8 -------------------------------------------------------------- */
  [
    'Tab 8 — a failed scrape, with no prices to judge',
    () => {
      const item = one({
        listingPrice: 200,
        flipkartDisplayPrice: null,
        winnerPrice: null,
        winnerSeller: null,
        currentBankSettlement: 180,
        minimumBankSettlement: 150,
        failed: true,
      });

      assert.equal(item.category, 'needsReview');
      assert.equal(item.scrapeFailed, true);
      assert.equal(item.scrapeStatus, 'PRODUCT_UNAVAILABLE');
    },
  ],

  /* -- the ordering ------------------------------------------------------- */
  [
    'The tabs are sequential: a record tab 1 claims never reaches tab 2',
    () => {
      // Both filters pass on this record — tab 1 gets it because it runs first.
      const item = one({
        listingPrice: 200,
        flipkartDisplayPrice: 210,
        winnerPrice: 205,
        benchmarkPrice: 250,
        currentBankSettlement: 180,
        minimumBankSettlement: 150,
      });

      assert.equal(item.category, 'priceChangeDiff');
      assert.equal(item.expectedListingPrice, 195);
    },
  ],

  [
    'A Buy Box loss that no earlier tab claims always lands in tab 4, never later',
    () => {
      const item = one(
        {
          listingPrice: 200,
          flipkartDisplayPrice: 210,
          winnerPrice: 150,
          benchmarkPrice: 0,
          currentBankSettlement: 180,
          minimumBankSettlement: 200,
          sellerCount: 1,
        },
        demand(0),
      );

      assert.equal(item.category, 'settlementUnsafe');
    },
  ],

  [
    'Classification is mutually exclusive: every record lands in at most one tab',
    () => {
      const items = many([
        // Tab 1.
        [
          {
            listingPrice: 200,
            flipkartDisplayPrice: 210,
            winnerPrice: 205,
            currentBankSettlement: 180,
            minimumBankSettlement: 150,
          },
          demand(0),
        ],
        // Tab 4.
        [
          {
            listingPrice: 257,
            flipkartDisplayPrice: 231,
            winnerPrice: 178,
            benchmarkPrice: 200,
            currentBankSettlement: 176,
            minimumBankSettlement: 190,
          },
          demand(0),
        ],
        // Tab 5.
        [
          {
            listingPrice: 200,
            flipkartDisplayPrice: 200,
            winnerPrice: 200,
            winnerSeller: SELLER,
            currentBankSettlement: 180,
            minimumBankSettlement: 150,
            sellerCount: 2,
          },
          demand(2),
        ],
        // Tab 8.
        [
          {
            flipkartDisplayPrice: null,
            winnerPrice: null,
            winnerSeller: null,
            failed: true,
          },
          demand(0),
        ],
      ]);

      assert.deepEqual(
        items.map((item) => item.category),
        ['priceChangeDiff', 'settlementUnsafe', 'buyboxWonGetOrder', 'needsReview'],
      );

      // Each record carries exactly one category, so the counts add up to the
      // number of records — nothing is double-filed.
      const counts = countRecommendations(items);
      const perTab = CATEGORY_ORDER.reduce((sum, category) => sum + counts[category], 0);
      assert.equal(counts.total, 4);
      assert.equal(perTab + counts.unclassified, counts.total);
      assert.equal(counts.unclassified, 0);
    },
  ],

  [
    'An unanswered Buy Box question lands in no tab rather than being guessed at',
    () => {
      const item = one({
        listingPrice: 200,
        flipkartDisplayPrice: 210,
        winnerPrice: 205,
        // Flipkart named no winning seller: hasBuybox is null, not false.
        winnerSeller: null,
        currentBankSettlement: 180,
        minimumBankSettlement: 150,
      });

      assert.equal(item.hasBuybox, null);
      assert.equal(item.category, null);
    },
  ],

  [
    'Without an orders report the order count is unknown, not zero',
    () => {
      const item = one(
        {
          listingPrice: 200,
          flipkartDisplayPrice: 200,
          winnerPrice: 200,
          winnerSeller: SELLER,
          currentBankSettlement: 180,
          minimumBankSettlement: 150,
          sellerCount: 1,
        },
        null,
      );

      assert.equal(item.orderCount, null);
      // Neither "> 0" nor "= 0" is true of an unknown count, so no Buy Box tab
      // claims it and it is not filed as a sole-seller listing by default.
      assert.equal(item.category, null);
    },
  ],
];

/* ---------------------------------------------------------------- the runner */

let failed = 0;

for (const [name, run] of CASES) {
  try {
    run();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n${CASES.length - failed}/${CASES.length} passed`);
if (failed > 0) process.exit(1);
