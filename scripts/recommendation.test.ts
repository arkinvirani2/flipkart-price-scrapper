import assert from 'node:assert/strict';
import { buildRecommendation } from '@/lib/recommendation';
import type { JobRow } from '@/types/dashboard';

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

assert.deepEqual(buildRecommendation(row({})), { key: 'x', fsn: 'FSN', diffAmount: -6, status: 'Not Safe' });
assert.equal(buildRecommendation(row({ bankSettlementThreshold: 100 })).status, 'Safe');
// Equal is not greater than, so it is not safe.
assert.equal(buildRecommendation(row({ bankSettlementThreshold: 113 })).status, 'Not Safe');
// No minimum for this SKU: the safety check stands down, the rest is unchanged.
assert.equal(buildRecommendation(row({ bankSettlementThreshold: undefined })).status, 'Safe');
assert.equal(buildRecommendation(row({ bankSettlementThreshold: 100, result: { ...row({}).result!, difference: 30 } })).status, 'Safe but more than 20%');
assert.deepEqual(buildRecommendation(row({ result: { ...row({}).result!, mainListingIsAccountSeller: true } })), { key: 'x', fsn: 'FSN', diffAmount: null, status: null });
assert.equal(buildRecommendation(row({ result: { ...row({}).result!, difference: 0 }, bankSettlementThreshold: 100 })).diffAmount, 0);
console.log('Recommendation tests passed.');
