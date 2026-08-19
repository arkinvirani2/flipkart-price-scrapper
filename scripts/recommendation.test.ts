/**
 * Tests for the recommendation calculation.
 *
 * There is no test runner in this project and adding one would be a bigger
 * change than the feature it is here to check, so this is a plain script: it
 * runs on the `ts-node` the scraper already uses, asserts with `node:assert`,
 * and exits non-zero when anything fails.
 *
 *     npm run test:recommendation
 *
 * The cases below are the ones the pricing brief asks for by name — the
 * Difference and the two figures derived from it, the Buy Box scenarios, the
 * minimum-settlement boundary, and the settlement-unavailable path.
 */

import assert from 'node:assert/strict';
import type { FsnDemand } from '@/lib/demand';
import {
  currentListingPrice,
  expectedBankSettlement,
  expectedListingPrice,
  expectedListingPriceAtRecommendation,
  minimumAcceptablePrice,
  priceDifference,
  recommendForRow,
  settlementUnsafeTarget,
  EMPTY_HISTORY,
  type DemandContext,
  type Recommendation,
} from '@/lib/recommendation';
import { computeSettlement } from '@/lib/settlement';
import type { JobRow } from '@/types/dashboard';

/* ------------------------------------------------------------- the fixture */

const SELLER = 'Shoppping Dil Se';

interface RowSpec {
  /** The sheet's "Your Listing Price" — the Current Listing Price. */
  listingPrice?: number;
  /** What Flipkart shows for our own listing, as scraped. */
  flipkartDisplayedPrice: number | null;
  /** The Buy Box price, as scraped. */
  winnerPrice: number | null;
  /** Who Flipkart names as the winner. Our own seller means we hold the Buy Box. */
  winningSeller?: string | null;
  currentBankSettlement?: number;
  minimumBankSettlement?: number;
  benchmarkPrice?: number;
  stockCount?: number;
}

function jobRow(spec: RowSpec): JobRow {
  return {
    index: 0,
    key: 'row-0',
    sku: 'SKU-1',
    fsn: 'FSN00000001',
    targetSeller: SELLER,
    productUrl: 'https://www.flipkart.com/p/itm000',
    status: 'success',
    listingPrice: spec.listingPrice,
    currentBankSettlement: spec.currentBankSettlement,
    bankSettlementThreshold: spec.minimumBankSettlement,
    benchmarkPrice: spec.benchmarkPrice,
    stockCount: spec.stockCount,
    result: {
      fsn: 'FSN00000001',
      sku: 'SKU-1',
      sellerName: SELLER,
      buyboxSellerName: spec.winningSeller === undefined ? 'Some Other Seller' : spec.winningSeller,
      mainPrice: spec.winnerPrice,
      sellerPrice: spec.flipkartDisplayedPrice,
      difference:
        spec.flipkartDisplayedPrice !== null && spec.winnerPrice !== null
          ? spec.flipkartDisplayedPrice - spec.winnerPrice
          : null,
      isPriceDifferent: spec.flipkartDisplayedPrice !== spec.winnerPrice,
      productUrl: 'https://www.flipkart.com/p/itm000',
      status: 'OK',
    },
  };
}

/** No orders report was uploaded at all — the 24h count is unknown, not zero. */
const NO_ORDERS: DemandContext = { ordersAvailable: false, demand: null, observedDays: 0 };

/**
 * An orders report covering `observedDays`, in which this FSN sold `last24hUnits`
 * yesterday and `unitsPerDay` on a normal day.
 */
function orders(last24hUnits: number, unitsPerDay: number, observedDays = 11): DemandContext {
  const historyDays = Math.max(1, observedDays - 1);
  const demand: FsnDemand = {
    fsn: 'FSN00000001',
    last24hUnits,
    last24hOrders: last24hUnits > 0 ? 1 : 0,
    historyUnits: unitsPerDay * historyDays,
    historyDays,
    unitsPerDay,
    activeDays: unitsPerDay > 0 ? historyDays : 0,
    cancelledUnits: 0,
    returnedUnits: 0,
  };
  return { ordersAvailable: true, demand, observedDays };
}

function recommend(spec: RowSpec, demand: DemandContext = NO_ORDERS): Recommendation {
  const row = jobRow(spec);
  return recommendForRow(row, computeSettlement(row), EMPTY_HISTORY, undefined, demand);
}

/* --------------------------------------------------------------- the cases */

const CASES: Array<[string, () => void]> = [
  /* -- case 1: the winner undercuts us ------------------------------------ */
  [
    'Case 1 — winner below us: 205 winner − 210 displayed = −5, expected listing 200 + (−5) = 195',
    () => {
      const item = recommend({
        listingPrice: 200,
        flipkartDisplayedPrice: 210,
        winnerPrice: 205,
        currentBankSettlement: 180,
        minimumBankSettlement: 150,
      });

      assert.equal(currentListingPrice(item), 200);
      assert.equal(item.difference, -5);
      assert.equal(expectedListingPrice(item), 195);
      // Expected Bank Settlement uses the same Difference, also added.
      assert.equal(expectedBankSettlement(item), 175);
    },
  ],

  /* -- case 2: the winner is dearer than us ------------------------------- */
  [
    'Case 2 — winner above us: 195 winner − 190 displayed = +5, expected listing 200 + 5 = 205',
    () => {
      const item = recommend({
        listingPrice: 200,
        flipkartDisplayedPrice: 190,
        winnerPrice: 195,
        currentBankSettlement: 180,
        minimumBankSettlement: 150,
      });

      assert.equal(item.difference, 5);
      assert.equal(expectedListingPrice(item), 205);
      assert.equal(expectedBankSettlement(item), 185);
      // Rule 5 owns the outcome, and it is a price change: the winner is dearer,
      // so the price rises to meet it rather than being ticked off as correct.
      assert.equal(item.rule, 'RULE_5');
      assert.equal(item.category, 'priceChange');
      assert.equal(item.recommendedPrice, 195);
      assert.equal(item.priceDelta, 5);
      assert.equal(item.projectedSettlement, 185);
    },
  ],

  [
    'Already correct holds only zero-Change rows — a positive Change is a price change',
    () => {
      const base = {
        listingPrice: 200,
        currentBankSettlement: 180,
        minimumBankSettlement: 150,
      };

      // Winner and Flipkart displayed price identical, Buy Box elsewhere.
      const matching = recommend({ ...base, flipkartDisplayedPrice: 200, winnerPrice: 200 });
      assert.equal(matching.category, 'alreadyCorrect');
      assert.equal(matching.hasBuybox, false);
      assert.equal(priceDifference(matching), 0);

      // The +33 / +2 / +1 rows: every one of them is actionable.
      for (const change of [33, 2, 1]) {
        const item = recommend({
          ...base,
          flipkartDisplayedPrice: 200,
          winnerPrice: 200 + change,
        });

        assert.equal(priceDifference(item), change);
        assert.equal(
          item.category,
          'priceChange',
          `a Change of +${change} must not sit in Already correct`,
        );
        assert.equal(item.recommendedPrice, 200 + change);
        assert.equal(expectedListingPrice(item), 200 + change);
        // Raising the price can only raise the settlement with it.
        assert.ok((item.projectedSettlement as number) > (item.currentSettlement as number));
        assert.ok((item.projectedSettlement as number) >= (item.minSettlement as number));
      }
    },
  ],

  [
    'The Difference is added, never subtracted, and reads the same way as the settlement view',
    () => {
      const spec = {
        listingPrice: 200,
        flipkartDisplayedPrice: 210,
        winnerPrice: 205,
        currentBankSettlement: 180,
        minimumBankSettlement: 150,
      };
      const item = recommend(spec);

      // lib/settlement measures the same gap in the same direction (winner −
      // ours), so the two screens quote one number, not two opposite ones.
      const settlement = computeSettlement(jobRow(spec));
      assert.equal(settlement.difference, -5);
      assert.equal(item.difference, settlement.difference);
      // And the settlement view's own final figure is the expected settlement.
      assert.equal(expectedBankSettlement(item), settlement.finalBankSettlement);

      assert.notEqual(expectedListingPrice(item), 200 - (item.difference as number));
      assert.notEqual(expectedBankSettlement(item), 180 - (item.difference as number));
    },
  ],

  [
    'The Difference is carried on rows that need no price change at all',
    () => {
      const item = recommend({
        listingPrice: 300,
        flipkartDisplayedPrice: 300,
        winnerPrice: 300,
        currentBankSettlement: 250,
        minimumBankSettlement: 200,
      });

      assert.equal(item.rule, 'RULE_3');
      assert.equal(item.recommendedPrice, null);
      assert.equal(item.difference, 0);
      assert.equal(expectedListingPrice(item), 300);
      assert.equal(expectedBankSettlement(item), 250);
    },
  ],

  /* -- case 3: Buy Box won, orders > 0 (tab 5) ---------------------------- */
  [
    'Case 3 — Buy Box own and orders > 0: rule 11 holds the price',
    () => {
      const item = recommend(
        {
          listingPrice: 200,
          flipkartDisplayedPrice: 200,
          winnerPrice: 200,
          winningSeller: SELLER,
          currentBankSettlement: 180,
          minimumBankSettlement: 150,
          benchmarkPrice: 190,
        },
        orders(4, 3),
      );

      assert.equal(item.hasBuybox, true);
      assert.equal(item.ordersLast24h, 4);
      assert.equal(item.rule, 'RULE_11');
      assert.equal(item.reasonCode, 'BUYBOX_HEALTHY');
      assert.equal(item.category, 'buyboxWon');
      assert.equal(item.recommendedPrice, null);
    },
  ],

  /* -- case 4: Buy Box won, orders = 0 (tab 6) ---------------------------- */
  [
    'Case 4 — Buy Box own and orders = 0: the benchmark price sets the target',
    () => {
      const item = recommend(
        {
          listingPrice: 200,
          flipkartDisplayedPrice: 200,
          winnerPrice: 200,
          winningSeller: SELLER,
          currentBankSettlement: 180,
          minimumBankSettlement: 150,
          benchmarkPrice: 195,
          stockCount: 10,
        },
        orders(0, 3),
      );

      assert.equal(item.hasBuybox, true);
      assert.equal(item.ordersLast24h, 0);
      assert.equal(item.benchmarkStatus, 'BENCHMARK_USABLE');
      assert.equal(item.rule, 'RULE_13');
      assert.equal(item.reasonCode, 'BUYBOX_STALE_REDUCE');
      // Flipkart's own benchmark, not the winner price and not the floor.
      assert.equal(item.recommendedPrice, 195);
      assert.equal(item.projectedSettlement, 175);
    },
  ],

  [
    'Case 4b — the benchmark is asked first, ahead of the zero-order evidence',
    () => {
      // A quiet day this FSN would have on its own — rule 12 territory. The
      // benchmark still clears the minimum settlement, so it sets the price.
      const item = recommend(
        {
          listingPrice: 200,
          flipkartDisplayedPrice: 200,
          winnerPrice: 200,
          winningSeller: SELLER,
          currentBankSettlement: 180,
          minimumBankSettlement: 150,
          benchmarkPrice: 195,
          stockCount: 10,
        },
        orders(0, 0.2),
      );

      // benchmark − fees = 195 − 20 = 175 > 150, so the benchmark wins.
      assert.equal(item.benchmarkStatus, 'BENCHMARK_USABLE');
      assert.equal(item.rule, 'RULE_13');
      assert.equal(item.recommendedPrice, 195);
      assert.equal(item.priceDelta, -5);
      assert.equal(item.projectedSettlement, 175);
      assert.ok((item.projectedSettlement as number) > (item.minSettlement as number));
    },
  ],

  [
    'Case 4c — benchmark − fees below the minimum settlement: the existing algorithm decides',
    () => {
      // Fees are 20, minimum settlement 150, so the floor is 170. A benchmark of
      // 160 fails "benchmark − fees > minimum bank settlement" and is ignored.
      const item = recommend(
        {
          listingPrice: 200,
          flipkartDisplayedPrice: 200,
          winnerPrice: 200,
          winningSeller: SELLER,
          currentBankSettlement: 180,
          minimumBankSettlement: 150,
          benchmarkPrice: 160,
          stockCount: 10,
        },
        orders(0, 0.2),
      );

      assert.equal(item.minAcceptablePrice, 170);
      assert.equal(item.benchmarkStatus, 'BELOW_THRESHOLD');
      // Back to the untouched zero-order rules: too little evidence to move.
      assert.equal(item.rule, 'RULE_12');
      assert.equal(item.reasonCode, 'BUYBOX_STALE_HOLD');
      assert.equal(item.recommendedPrice, null);
    },
  ],

  [
    'Case 4d — no benchmark published: the existing algorithm decides, unchanged',
    () => {
      const item = recommend(
        {
          listingPrice: 200,
          flipkartDisplayedPrice: 200,
          winnerPrice: 200,
          winningSeller: SELLER,
          currentBankSettlement: 180,
          minimumBankSettlement: 150,
          benchmarkPrice: 0,
          stockCount: 10,
        },
        orders(0, 3),
      );

      assert.equal(item.benchmarkStatus, 'BENCHMARK_ZERO');
      // The strong zero-order signal still buys its capped 5% cut: 200 → 190.
      assert.equal(item.rule, 'RULE_13');
      assert.equal(item.recommendedPrice, 190);
    },
  ],

  [
    'Case 4e — the no-orders tab quotes its Change and expected figures off the recommendation',
    () => {
      const item = recommend(
        {
          listingPrice: 220,
          flipkartDisplayedPrice: 200,
          winnerPrice: 200,
          winningSeller: SELLER,
          currentBankSettlement: 180,
          minimumBankSettlement: 150,
          benchmarkPrice: 195,
          stockCount: 10,
        },
        orders(0, 3),
      );

      assert.equal(item.recommendedPrice, 195);
      // Change = benchmark − Flipkart displayed price.
      assert.equal(item.priceDelta, -5);
      // Expected listing price = current listing price + change.
      assert.equal(expectedListingPriceAtRecommendation(item), 215);
      // Expected bank settlement = current bank settlement + change.
      assert.equal(item.projectedSettlement, 175);

      // The winner-based Change is useless here — the winner is us — which is
      // why this tab does not use it.
      assert.equal(priceDifference(item), 0);
    },
  ],

  [
    'Case 4f — zero stock still wins over the benchmark: no price can sell absent stock',
    () => {
      const item = recommend(
        {
          listingPrice: 200,
          flipkartDisplayedPrice: 200,
          winnerPrice: 200,
          winningSeller: SELLER,
          currentBankSettlement: 180,
          minimumBankSettlement: 150,
          benchmarkPrice: 195,
          stockCount: 0,
        },
        orders(0, 3),
      );

      assert.equal(item.rule, 'RULE_11');
      assert.equal(item.reasonCode, 'BUYBOX_NO_STOCK');
      assert.equal(item.recommendedPrice, null);
    },
  ],

  /* -- case 5: the minimum settlement boundary ---------------------------- */
  [
    'Case 5 — the minimum-settlement price is the minimum bank settlement plus the fees',
    () => {
      const row = jobRow({
        listingPrice: 200,
        flipkartDisplayedPrice: 200,
        winnerPrice: 100,
        currentBankSettlement: 180,
        minimumBankSettlement: 150,
      });
      const settlement = computeSettlement(row);

      // Fees are what the price loses on the way to the settlement: 200 − 180.
      const fees = 200 - 180;
      assert.equal(minimumAcceptablePrice(settlement), 150 + fees);
    },
  ],

  [
    'Case 5b — a price that would settle below the minimum is never recommended',
    () => {
      const item = recommend({
        listingPrice: 200,
        flipkartDisplayedPrice: 200,
        winnerPrice: 100,
        currentBankSettlement: 180,
        minimumBankSettlement: 150,
      });

      assert.equal(item.rule, 'RULE_9');
      assert.equal(item.category, 'settlementUnsafe');
      assert.equal(item.recommendedPrice, null);
      assert.equal(item.projectedSettlement, 80);
      assert.ok((item.projectedSettlement as number) < (item.minSettlement as number));
    },
  ],

  [
    'Settlement unsafe — the benchmark clears the check, so it stands in as the winner',
    () => {
      // Fees 20, minimum 150 → floor 170. The winner at 100 is unaffordable, but
      // the benchmark at 190 leaves 170 in settlement, comfortably over 150.
      const item = recommend({
        listingPrice: 220,
        flipkartDisplayedPrice: 200,
        winnerPrice: 100,
        currentBankSettlement: 180,
        minimumBankSettlement: 150,
        benchmarkPrice: 190,
      });

      assert.equal(item.category, 'settlementUnsafe');
      assert.equal(item.benchmarkStatus, 'BENCHMARK_USABLE');

      const derived = settlementUnsafeTarget(item);
      assert.equal(derived.benchmarkUsable, true);
      assert.equal(derived.target, 190);
      // Change = benchmark − Flipkart displayed price, exactly as it would be
      // computed from a real winner price.
      assert.equal(derived.change, -10);
      assert.equal(derived.expectedListingPrice, 210);
      assert.equal(derived.expectedBankSettlement, 170);
      assert.ok((derived.expectedBankSettlement as number) > (item.minSettlement as number));

      // The row stays on this list, with the rule the engine gave it.
      assert.equal(item.rule, 'RULE_9');
      assert.equal(item.recommendedPrice, null);
    },
  ],

  [
    'Settlement unsafe — benchmark fails the check, so the floor supplies both figures',
    () => {
      // A benchmark of 160 leaves only 140 in settlement, under the 150 minimum.
      const item = recommend({
        listingPrice: 220,
        flipkartDisplayedPrice: 200,
        winnerPrice: 100,
        currentBankSettlement: 180,
        minimumBankSettlement: 150,
        benchmarkPrice: 160,
      });

      assert.equal(item.category, 'settlementUnsafe');
      assert.equal(item.benchmarkStatus, 'BELOW_THRESHOLD');

      const derived = settlementUnsafeTarget(item);
      assert.equal(derived.benchmarkUsable, false);
      // Expected listing price = minimum bank settlement + fees.
      assert.equal(derived.expectedListingPrice, 170);
      assert.equal(derived.expectedListingPrice, item.minAcceptablePrice);
      // Expected bank settlement = minimum bank settlement, exactly.
      assert.equal(derived.expectedBankSettlement, 150);
      assert.equal(derived.expectedBankSettlement, item.minSettlement);
      assert.equal(derived.change, -30);
    },
  ],

  [
    'Settlement unsafe — no benchmark at all still falls to the floor',
    () => {
      const item = recommend({
        listingPrice: 200,
        flipkartDisplayedPrice: 200,
        winnerPrice: 100,
        currentBankSettlement: 180,
        minimumBankSettlement: 150,
        benchmarkPrice: 0,
      });

      const derived = settlementUnsafeTarget(item);
      assert.equal(derived.benchmarkUsable, false);
      assert.equal(derived.expectedListingPrice, 170);
      assert.equal(derived.expectedBankSettlement, 150);
    },
  ],

  [
    'Settlement unsafe — a benchmark with no floor to test it against is not usable',
    () => {
      // Buy Box ours and the settlement values missing: the Tab 4 path. The
      // benchmark reads USABLE only because there was no floor to fail against,
      // so it must not be treated as having passed the check.
      const item = recommend(
        {
          listingPrice: 200,
          flipkartDisplayedPrice: 200,
          winnerPrice: 190,
          winningSeller: SELLER,
          benchmarkPrice: 195,
          stockCount: 10,
        },
        orders(0, 3),
      );

      assert.equal(item.category, 'settlementUnsafe');
      assert.equal(item.minAcceptablePrice, null);

      const derived = settlementUnsafeTarget(item);
      assert.equal(derived.benchmarkUsable, false);
      assert.equal(derived.expectedListingPrice, null);
      assert.equal(derived.expectedBankSettlement, null);
    },
  ],

  [
    'Case 5c — landing exactly on the minimum settlement is allowed',
    () => {
      // The floor is 170; matching a winner at 170 settles at exactly 150.
      const item = recommend({
        listingPrice: 200,
        flipkartDisplayedPrice: 200,
        winnerPrice: 170,
        currentBankSettlement: 180,
        minimumBankSettlement: 150,
      });

      assert.equal(item.minAcceptablePrice, 170);
      assert.equal(item.category, 'priceChange');
      assert.equal(item.recommendedPrice, 170);
      assert.equal(item.projectedSettlement, 150);
      assert.equal(item.projectedSettlement, item.minSettlement);
    },
  ],

  [
    'Case 5d — a recommended price always settles at or above the minimum',
    () => {
      for (const winnerPrice of [100, 150, 169, 170, 171, 190, 199]) {
        const item = recommend({
          listingPrice: 200,
          flipkartDisplayedPrice: 200,
          winnerPrice,
          currentBankSettlement: 180,
          minimumBankSettlement: 150,
        });

        if (item.recommendedPrice === null) continue;
        assert.ok(
          (item.projectedSettlement as number) >= (item.minSettlement as number),
          `winner ${winnerPrice} produced a settlement below the minimum`,
        );
        assert.ok(
          item.recommendedPrice >= (item.minAcceptablePrice as number),
          `winner ${winnerPrice} produced a price below the minimum acceptable price`,
        );
      }
    },
  ],

  /* -- case 6: settlement unavailable (tab 4) ----------------------------- */
  [
    'Case 6 — Buy Box own with the settlement values missing: the normal calculation is still shown',
    () => {
      const item = recommend(
        {
          listingPrice: 200,
          flipkartDisplayedPrice: 200,
          winnerPrice: 190,
          winningSeller: SELLER,
          benchmarkPrice: 195,
          stockCount: 10,
        },
        orders(0, 3),
      );

      assert.equal(item.hasBuybox, true);
      assert.equal(item.currentSettlement, null);
      assert.equal(item.minSettlement, null);
      assert.equal(item.minAcceptablePrice, null);

      // Rules 4/6/7 still choose the target, and it is shown rather than withheld.
      assert.equal(item.rule, 'RULE_4');
      assert.equal(item.category, 'settlementUnsafe');
      assert.equal(item.recommendedPrice, 190);
      assert.equal(item.priceDelta, -10);
      assert.ok(item.appliedRules.includes('RULE_2'));
      // No settlement values means no fees, so no minimum-settlement fallback.
      assert.equal(item.projectedSettlement, null);

      // The Difference and the expected listing price are still computable.
      assert.equal(item.difference, -10);
      assert.equal(expectedListingPrice(item), 190);
      assert.equal(expectedBankSettlement(item), null);
    },
  ],

  [
    'Case 6b — settlement values missing and the normal calculation wants no change',
    () => {
      const item = recommend(
        {
          listingPrice: 200,
          flipkartDisplayedPrice: 200,
          winnerPrice: 200,
          winningSeller: SELLER,
          benchmarkPrice: 195,
          stockCount: 10,
        },
        orders(0, 3),
      );

      assert.equal(item.rule, 'RULE_2');
      assert.equal(item.category, 'settlementUnsafe');
      assert.equal(item.recommendedPrice, null);
    },
  ],

  [
    'Buy Box own with no orders report at all: rule 1 is unchanged',
    () => {
      const item = recommend({
        listingPrice: 200,
        flipkartDisplayedPrice: 200,
        winnerPrice: 200,
        winningSeller: SELLER,
        currentBankSettlement: 180,
        minimumBankSettlement: 150,
      });

      assert.equal(item.rule, 'RULE_1');
      assert.equal(item.reasonCode, 'NO_ORDER_DATA');
      assert.equal(item.category, 'buyboxWon');
      assert.equal(item.ordersLast24h, null);
    },
  ],

  [
    'A row with no prices carries no Difference',
    () => {
      const item = recommend({
        listingPrice: 200,
        flipkartDisplayedPrice: null,
        winnerPrice: null,
        currentBankSettlement: 180,
        minimumBankSettlement: 150,
      });

      assert.equal(item.rule, 'NO_DATA');
      assert.equal(item.difference, null);
      assert.equal(expectedListingPrice(item), null);
      assert.equal(expectedBankSettlement(item), null);
    },
  ],

  [
    'Without a listing price column the Flipkart displayed price stands in, as before',
    () => {
      const item = recommend({
        flipkartDisplayedPrice: 210,
        winnerPrice: 205,
        currentBankSettlement: 180,
        minimumBankSettlement: 150,
      });

      assert.equal(currentListingPrice(item), 210);
      assert.equal(expectedListingPrice(item), 205);
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
