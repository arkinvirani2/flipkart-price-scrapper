import assert from 'node:assert/strict';
import { buildRecommendation } from '@/lib/recommendation';
import { computeSettlement } from '@/lib/settlement';
import type { JobRow } from '@/types/dashboard';

/**
 * `difference` on the result is the scraper's own direction (sellerPrice −
 * mainPrice) and is deliberately left wrong-way-round here: the recommendation
 * must not read it, so every case below would break if it started doing so again.
 */
function row(overrides: Partial<JobRow>): JobRow {
  return {
    index: 0, key: 'x', sku: 'x', fsn: 'FSN', targetSeller: 'Anuttar', productUrl: 'https://www.flipkart.com/x',
    status: 'success', currentBankSettlement: 119, bankSettlementThreshold: 115,
    result: {
      fsn: 'FSN', sku: 'x', sellerName: 'Anuttar', buyboxSellerName: 'Other',
      mainPrice: 125, sellerPrice: 119, difference: -6, isPriceDifferent: true,
      productUrl: 'https://www.flipkart.com/x', status: 'OK',
    },
    ...overrides,
  };
}

/** A row with explicit prices, so a case reads as the business states it. */
function priced(ourPrice: number, winnerPrice: number, overrides: Partial<JobRow> = {}): JobRow {
  return row({
    result: {
      ...row({}).result!,
      mainPrice: winnerPrice,
      sellerPrice: ourPrice,
      difference: ourPrice - winnerPrice,
      isPriceDifferent: ourPrice !== winnerPrice,
    },
    ...overrides,
  });
}

/* ------------------------------------------------ Case A — dearer than winner */
// SRPHMHHCGKTUECRY from the live batch: we are ₹22 dear, so the settlement must
// fall to 81 and break the ₹100 minimum. The old maths read 103 + 22 = 125 Safe.
{
  const input = priced(163, 141, { currentBankSettlement: 103, bankSettlementThreshold: 100 });
  const recommendation = buildRecommendation(input);
  assert.equal(recommendation.diffAmount, -22, 'Diff Amount is mainPrice − sellerPrice');
  assert.equal(computeSettlement(input).finalBankSettlement, 81, 'settlement drops to 81');
  assert.equal(recommendation.status, 'Not Safe');
  assert.notEqual(recommendation.status, 'Safe');
}

/* --------------------------------------- Case B — settlement equals threshold */
// 120 − 20 = 100 against a minimum of 100. Equal is not greater, so not safe.
{
  const input = priced(150, 130, { currentBankSettlement: 120, bankSettlementThreshold: 100 });
  assert.equal(computeSettlement(input).finalBankSettlement, 100);
  assert.equal(buildRecommendation(input).status, 'Not Safe');
  // The settlement view must agree: equal does not clear the threshold there either.
  assert.equal(computeSettlement(input).category, 'below');
}

/* ---------------------------------------- Case C — settlement above threshold */
// 121 − 20 = 101 against a minimum of 100, and ₹20 is within 20% of ₹150.
{
  const input = priced(150, 130, { currentBankSettlement: 121, bankSettlementThreshold: 100 });
  assert.equal(computeSettlement(input).finalBankSettlement, 101);
  assert.equal(buildRecommendation(input).status, 'Safe');
  assert.equal(computeSettlement(input).category, 'main');
}

/* ------------------------------------------------- Case D — missing threshold */
// No minimum for this SKU: unanswerable, and never quietly Safe.
{
  const recommendation = buildRecommendation(priced(163, 141, { currentBankSettlement: 103, bankSettlementThreshold: undefined }));
  assert.equal(recommendation.status, 'Threshold Missing');
  assert.notEqual(recommendation.status, 'Safe');
  assert.notEqual(recommendation.status, 'Not Safe');
  assert.equal(recommendation.reason, 'No Minimum Bank Settlement for this SKU');
  // The diff is still known and still reported.
  assert.equal(recommendation.diffAmount, -22);
}

/* --------------------------------------------- Case E — unevaluated, never blank */
{
  const failed = buildRecommendation(row({ result: { ...row({}).result!, status: 'BLOCKED' } }));
  assert.equal(failed.status, 'Need Review');
  assert.equal(failed.reason, 'Scrape failed (BLOCKED)');

  const pending = buildRecommendation(row({ result: undefined, status: 'pending' }));
  assert.equal(pending.status, 'Need Review');
  assert.equal(pending.reason, 'Not yet scraped');

  const ours = buildRecommendation(row({ result: { ...row({}).result!, mainListingIsAccountSeller: true } }));
  assert.equal(ours.status, 'Need Review');
  assert.equal(ours.reason, 'Account already holds the main listing');

  const noPrice = buildRecommendation(row({ result: { ...row({}).result!, mainPrice: null, difference: null } }));
  assert.equal(noPrice.status, 'Need Review');
  assert.equal(noPrice.reason, 'Missing price data');

  const noCurrent = buildRecommendation(priced(163, 141, { currentBankSettlement: undefined }));
  assert.equal(noCurrent.status, 'Need Review');
  assert.equal(noCurrent.reason, 'Missing current bank settlement');

  // The whole point: no row anywhere comes back without a status.
  for (const item of [failed, pending, ours, noPrice, noCurrent]) {
    assert.ok(item.status, 'every row carries a status');
    assert.ok(item.reason, 'an unevaluated row explains itself');
  }
}

/* ------------------------------------------------- preserved existing coverage */
// We are ₹6 cheaper than the buy box, so the settlement rises: 119 + 6 = 125 > 115.
assert.deepEqual(buildRecommendation(row({})), { key: 'x', fsn: 'FSN', diffAmount: 6, status: 'Safe', reason: null });
// ₹30 on a ₹100 price is over the 20% band.
assert.equal(buildRecommendation(priced(100, 130, { currentBankSettlement: 119, bankSettlementThreshold: 115 })).status, 'Safe but more than 20%');
// A matched price still scores, and reports a zero diff rather than a blank.
{
  const level = buildRecommendation(priced(150, 150, { currentBankSettlement: 119, bankSettlementThreshold: 115 }));
  assert.equal(level.diffAmount, 0);
  assert.equal(level.status, 'Safe');
}
// Not Safe outranks the 20% band: breaking the minimum is the more serious call.
assert.equal(buildRecommendation(priced(100, 130, { currentBankSettlement: 119, bankSettlementThreshold: 160 })).status, 'Not Safe');

console.log('Recommendation tests passed.');
