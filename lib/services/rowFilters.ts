/**
 * Queue filtering.
 *
 * Lives in one module because the same predicate has to serve three callers:
 * the rows API, the failed-products page, and the export endpoint. An export
 * that silently ignored the filters the user could see on screen would be a
 * lie, so they all run this.
 */

import type { JobRow, RowStatus, ScrapeStatus } from '@/types/dashboard';

export interface RowFilters {
  /** Matched against sku, fsn, seller, url, status and failure message. */
  search?: string;
  status?: RowStatus[];
  failureReason?: ScrapeStatus[];
  sku?: string;
  fsn?: string;
  seller?: string;
  productUrl?: string;
  /** ISO dates, inclusive, against the row's completion time. */
  from?: string;
  to?: string;
  minDurationMs?: number;
  maxDurationMs?: number;
  /** Only rows whose page price differs from the seller price. */
  priceMismatchOnly?: boolean;
}

export function parseRowFilters(params: URLSearchParams): RowFilters {
  const list = (key: string): string[] | undefined => {
    const raw = params.getAll(key).flatMap((value) => value.split(',')).filter(Boolean);
    return raw.length ? raw : undefined;
  };

  const num = (key: string): number | undefined => {
    const raw = params.get(key);
    if (raw === null || raw === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };

  const text = (key: string): string | undefined => params.get(key)?.trim() || undefined;

  return {
    search: text('search'),
    status: list('status') as RowStatus[] | undefined,
    failureReason: list('reason') as ScrapeStatus[] | undefined,
    sku: text('sku'),
    fsn: text('fsn'),
    seller: text('seller'),
    productUrl: text('url'),
    from: text('from'),
    to: text('to'),
    minDurationMs: num('minDuration'),
    maxDurationMs: num('maxDuration'),
    priceMismatchOnly: params.get('mismatch') === 'true',
  };
}

export function filterRows(rows: JobRow[], filters: RowFilters): JobRow[] {
  const search = filters.search?.toLowerCase();
  const from = filters.from ? Date.parse(filters.from) : undefined;
  // `to` is a date the user picked, so it should include that whole day rather
  // than cutting off at midnight.
  const to = filters.to ? Date.parse(filters.to) + (filters.to.length <= 10 ? 86_399_999 : 0) : undefined;

  return rows.filter((row) => {
    if (filters.status?.length && !filters.status.includes(row.status)) return false;

    if (filters.failureReason?.length) {
      const reason = row.result?.status;
      if (!reason || !filters.failureReason.includes(reason)) return false;
    }

    if (!contains(row.sku, filters.sku)) return false;
    if (!contains(row.fsn, filters.fsn)) return false;
    if (!contains(row.targetSeller, filters.seller)) return false;
    if (!contains(row.productUrl, filters.productUrl)) return false;

    if (from !== undefined || to !== undefined) {
      const finished = row.finishedAt ? Date.parse(row.finishedAt) : undefined;
      if (finished === undefined || Number.isNaN(finished)) return false;
      if (from !== undefined && finished < from) return false;
      if (to !== undefined && finished > to) return false;
    }

    if (filters.minDurationMs !== undefined && (row.durationMs ?? -1) < filters.minDurationMs) return false;
    if (filters.maxDurationMs !== undefined && (row.durationMs ?? Number.MAX_SAFE_INTEGER) > filters.maxDurationMs) {
      return false;
    }

    if (filters.priceMismatchOnly && !row.result?.isPriceDifferent) return false;

    if (search) {
      const haystack = [
        row.sku,
        row.fsn,
        row.targetSeller,
        row.productUrl,
        row.status,
        row.result?.status,
        row.result?.sellerName,
        row.message,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      if (!haystack.includes(search)) return false;
    }

    return true;
  });
}

function contains(value: string | undefined, needle: string | undefined): boolean {
  if (!needle) return true;
  return (value ?? '').toLowerCase().includes(needle.toLowerCase());
}
