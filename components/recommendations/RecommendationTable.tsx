'use client';

import { ArrowDown, ArrowUp, ChevronsUpDown, Eye, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatPrice, formatSettlement, formatSignedNumber } from '@/lib/format';
import type { Recommendation, RecommendationCategory } from '@/lib/recommendation';
import { sellerListingUrl } from '@/lib/settlement';
import { cn } from '@/lib/utils';

/**
 * The record list for one tab.
 *
 * Paginated rather than virtualized, unlike the queue: this is a list you work
 * through in order and tick off, so a page number is a more useful position than
 * a scroll offset. Search, sort and page size all live in this component's own
 * state, so switching tabs starts each list clean.
 *
 * As in the settlement table, clicking a row opens that product's Flipkart
 * Seller Hub listing in a new tab, so the price can be changed where it is
 * shown. The View button stays a separate action for the detail dialog.
 */

type SortDirection = 'asc' | 'desc';

interface SortableColumn {
  key: string;
  header: string;
  align?: 'left' | 'right';
  /** Null sorts last in both directions — a missing figure is not a small one. */
  sortValue?: (item: Recommendation) => number | string | null;
  cell: (item: Recommendation) => React.ReactNode;
}

const PAGE_SIZES = [25, 50, 100, 250];

/* ------------------------------------------------------------- the columns */

const FSN: SortableColumn = {
  key: 'fsn',
  header: 'FSN',
  sortValue: (item) => item.fsn,
  cell: (item) => (
    <span className="block truncate font-medium" title={item.fsn}>
      {item.fsn}
    </span>
  ),
};

/**
 * Do we hold the Buy Box?
 *
 * Null is not No. It means Flipkart never named a winning seller for the page,
 * so the question was never answered — printing "No" there would invent a loss
 * that was never observed.
 */
const BUY_BOX_WON: SortableColumn = {
  key: 'hasBuybox',
  header: 'Buy Box won',
  sortValue: (item) => (item.hasBuybox === null ? null : item.hasBuybox ? 'Yes' : 'No'),
  cell: (item) =>
    item.hasBuybox === null ? (
      <span className="text-muted-foreground" title="Flipkart named no winning seller for this listing">
        —
      </span>
    ) : item.hasBuybox ? (
      <span className="font-medium text-status-success">Yes</span>
    ) : (
      <span className="text-muted-foreground">No</span>
    ),
};

/** Sheet 1's "Your Selling Price" — the number the seller actually edits. */
const CURRENT_LISTING_PRICE: SortableColumn = {
  key: 'listingPrice',
  header: 'Current listing price',
  align: 'right',
  sortValue: (item) => item.listingPrice,
  cell: (item) => formatPrice(item.listingPrice),
};

/**
 * The price Flipkart shows a buyer for *our* listing, as scraped.
 *
 * Headed by what it is rather than "Current price": the sheet's own listing
 * price is a different number, and the two must never be read as each other.
 */
const FLIPKART_DISPLAY_OUR_PRICE: SortableColumn = {
  key: 'flipkartDisplayPrice',
  header: 'Flipkart display our price',
  align: 'right',
  sortValue: (item) => item.flipkartDisplayPrice,
  cell: (item) => formatPrice(item.flipkartDisplayPrice),
};

const WINNER_PRICE: SortableColumn = {
  key: 'winnerPrice',
  header: 'Winner price',
  align: 'right',
  sortValue: (item) => item.winnerPrice,
  cell: (item) => formatPrice(item.winnerPrice),
};

const BENCHMARK_PRICE: SortableColumn = {
  key: 'benchmarkPrice',
  header: 'Benchmark price',
  align: 'right',
  sortValue: (item) => item.benchmarkPrice,
  cell: (item) => formatPrice(item.benchmarkPrice),
};

/** Winner price − Flipkart display our price. */
const CHANGE: SortableColumn = {
  key: 'difference',
  header: 'Change',
  align: 'right',
  sortValue: (item) => item.difference,
  cell: (item) => <span className="font-medium">{formatSignedNumber(item.difference)}</span>,
};

/** Benchmark price − Flipkart display our price. */
const BENCHMARK_DIFFERENCE: SortableColumn = {
  key: 'benchmarkDifference',
  header: 'Benchmark difference',
  align: 'right',
  sortValue: (item) => item.benchmarkDifference,
  cell: (item) => <span className="font-medium">{formatSignedNumber(item.benchmarkDifference)}</span>,
};

const EXPECTED_LISTING_PRICE: SortableColumn = {
  key: 'expectedListingPrice',
  header: 'Expected listing price',
  align: 'right',
  sortValue: (item) => item.expectedListingPrice,
  cell: (item) => (
    <span className="font-semibold text-status-success">{formatPrice(item.expectedListingPrice)}</span>
  ),
};

const EXPECTED_BANK_SETTLEMENT: SortableColumn = {
  key: 'expectedBankSettlement',
  header: 'Expected bank settlement',
  align: 'right',
  sortValue: (item) => item.expectedBankSettlement,
  cell: (item) => (
    <span className="font-semibold text-status-success">
      {formatSettlement(item.expectedBankSettlement)}
    </span>
  ),
};

const MINIMUM_BANK_SETTLEMENT: SortableColumn = {
  key: 'minSettlement',
  header: 'Minimum bank settlement',
  align: 'right',
  sortValue: (item) => item.minSettlement,
  cell: (item) => formatSettlement(item.minSettlement),
};

const WINNER_SELLER: SortableColumn = {
  key: 'winnerSeller',
  header: 'Winner seller',
  sortValue: (item) => item.winnerSeller,
  cell: (item) =>
    item.winnerSeller ? (
      <span className="block truncate" title={item.winnerSeller}>
        {item.winnerSeller}
      </span>
    ) : (
      <span className="text-muted-foreground">—</span>
    ),
};

/** Units ordered for this FSN in the last 24 hours, from sheet 3. */
const ORDERS_COUNT: SortableColumn = {
  key: 'orderCount',
  header: 'Orders count (24h)',
  align: 'right',
  sortValue: (item) => item.orderCount,
  cell: (item) =>
    item.orderCount === null ? (
      <span className="text-muted-foreground" title="No orders report was uploaded with this batch">
        —
      </span>
    ) : (
      <span className={cn(item.orderCount === 0 && 'font-medium text-status-failed')}>
        {item.orderCount}
      </span>
    ),
};

/** Why the scrape produced nothing to judge. The Needs review tab only. */
const SCRAPE_STATUS: SortableColumn = {
  key: 'scrapeStatus',
  header: 'Scrape status',
  sortValue: (item) => item.scrapeStatus,
  cell: (item) => (
    <span
      className="block truncate text-muted-foreground"
      title={item.scrapeMessage ?? item.scrapeStatus ?? 'Not scraped'}
    >
      {item.scrapeStatus ?? 'Not scraped'}
    </span>
  ),
};

/**
 * The columns each tab shows, exactly as its specification lists them.
 *
 * Held as one map keyed by category so a tab cannot be given another tab's
 * columns by accident — the page looks its set up by the same key it filters on.
 */
export const TAB_COLUMNS: Record<RecommendationCategory, SortableColumn[]> = {
  priceChangeDiff: [
    FSN,
    BUY_BOX_WON,
    CURRENT_LISTING_PRICE,
    FLIPKART_DISPLAY_OUR_PRICE,
    WINNER_PRICE,
    BENCHMARK_PRICE,
    CHANGE,
    EXPECTED_LISTING_PRICE,
    EXPECTED_BANK_SETTLEMENT,
    MINIMUM_BANK_SETTLEMENT,
    WINNER_SELLER,
    ORDERS_COUNT,
  ],

  priceChangeBenchmark: [
    FSN,
    BUY_BOX_WON,
    FLIPKART_DISPLAY_OUR_PRICE,
    WINNER_PRICE,
    BENCHMARK_PRICE,
    CHANGE,
    BENCHMARK_DIFFERENCE,
    EXPECTED_LISTING_PRICE,
    EXPECTED_BANK_SETTLEMENT,
    MINIMUM_BANK_SETTLEMENT,
    WINNER_SELLER,
    ORDERS_COUNT,
  ],

  alreadyCorrect: [
    FSN,
    BUY_BOX_WON,
    FLIPKART_DISPLAY_OUR_PRICE,
    WINNER_PRICE,
    BENCHMARK_PRICE,
    CHANGE,
    MINIMUM_BANK_SETTLEMENT,
    WINNER_SELLER,
    ORDERS_COUNT,
  ],

  settlementUnsafe: [
    FSN,
    BUY_BOX_WON,
    FLIPKART_DISPLAY_OUR_PRICE,
    WINNER_PRICE,
    BENCHMARK_PRICE,
    CHANGE,
    EXPECTED_LISTING_PRICE,
    EXPECTED_BANK_SETTLEMENT,
    MINIMUM_BANK_SETTLEMENT,
    WINNER_SELLER,
    ORDERS_COUNT,
  ],

  buyboxWonGetOrder: [
    FSN,
    BUY_BOX_WON,
    FLIPKART_DISPLAY_OUR_PRICE,
    WINNER_PRICE,
    BENCHMARK_PRICE,
    CHANGE,
    MINIMUM_BANK_SETTLEMENT,
    WINNER_SELLER,
    ORDERS_COUNT,
  ],

  buyboxWonNoOrderMultiSeller: [
    FSN,
    BUY_BOX_WON,
    FLIPKART_DISPLAY_OUR_PRICE,
    WINNER_PRICE,
    BENCHMARK_PRICE,
    CHANGE,
    EXPECTED_LISTING_PRICE,
    EXPECTED_BANK_SETTLEMENT,
    MINIMUM_BANK_SETTLEMENT,
    WINNER_SELLER,
    ORDERS_COUNT,
  ],

  buyboxWonNoOrderSingleSeller: [
    FSN,
    BUY_BOX_WON,
    FLIPKART_DISPLAY_OUR_PRICE,
    WINNER_PRICE,
    BENCHMARK_PRICE,
    CHANGE,
    MINIMUM_BANK_SETTLEMENT,
    WINNER_SELLER,
    ORDERS_COUNT,
  ],

  needsReview: [FSN, BUY_BOX_WON, FLIPKART_DISPLAY_OUR_PRICE, WINNER_PRICE, SCRAPE_STATUS],
};

/* --------------------------------------------------------------- the table */

interface Props {
  rows: Recommendation[];
  columns: SortableColumn[];
  emptyMessage: string;
  onView: (item: Recommendation) => void;
  /** Rendered next to the search box — the export buttons on the first tab. */
  actions?: React.ReactNode;
  /** Lets the page mirror the search into the export link. */
  onSearchChange?: (value: string) => void;
}

export function RecommendationTable({
  rows,
  columns,
  emptyMessage,
  onView,
  actions,
  onSearchChange,
}: Props) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: string; direction: SortDirection } | null>(null);
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;

    return rows.filter((item) =>
      [item.sku, item.fsn, item.winnerSeller, item.seller]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [rows, search]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const column = columns.find((item) => item.key === sort.key);
    if (!column?.sortValue) return filtered;

    const factor = sort.direction === 'asc' ? 1 : -1;
    return [...filtered].sort((left, right) => {
      const a = column.sortValue?.(left) ?? null;
      const b = column.sortValue?.(right) ?? null;

      // Missing values always sink, whichever way the column is sorted — a blank
      // cell floating to the top of a descending sort is just noise.
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;

      if (typeof a === 'number' && typeof b === 'number') return (a - b) * factor;
      return String(a).localeCompare(String(b)) * factor;
    });
  }, [filtered, sort, columns]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(page, pageCount - 1);
  const visible = sorted.slice(current * pageSize, current * pageSize + pageSize);

  // Any change to what is being listed sends the user back to the first page —
  // page 7 of a two-page result is a dead end.
  useEffect(() => {
    setPage(0);
  }, [search, pageSize, rows]);

  const openListing = (fsn: string) =>
    window.open(sellerListingUrl(fsn), '_blank', 'noopener,noreferrer');

  function toggleSort(key: string) {
    setSort((currentSort) => {
      if (currentSort?.key !== key) return { key, direction: 'asc' };
      if (currentSort.direction === 'asc') return { key, direction: 'desc' };
      return null;
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[16rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              onSearchChange?.(event.target.value);
            }}
            placeholder="Search SKU, FSN or seller…"
            className="pl-8"
            aria-label="Search records"
          />
        </div>

        <span className="tabular text-xs text-muted-foreground">
          {sorted.length === rows.length
            ? `${rows.length} row${rows.length === 1 ? '' : 's'}`
            : `${sorted.length} of ${rows.length}`}
        </span>

        {actions}
      </div>

      <div className="overflow-hidden rounded-lg border">
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full min-w-[56rem] caption-bottom text-sm">
            <thead className="border-b bg-muted">
              <tr>
                {columns.map((column) => {
                  const active = sort?.key === column.key;
                  const Icon = !active ? ChevronsUpDown : sort.direction === 'asc' ? ArrowUp : ArrowDown;

                  return (
                    <th
                      key={column.key}
                      scope="col"
                      className={cn(
                        'h-10 px-3 text-left align-middle text-[11px] font-medium uppercase tracking-wide text-muted-foreground',
                        column.align === 'right' && 'text-right',
                      )}
                    >
                      {column.sortValue ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(column.key)}
                          className={cn(
                            'inline-flex items-center gap-1 transition-colors hover:text-foreground',
                            active && 'text-foreground',
                            column.align === 'right' && 'flex-row-reverse',
                          )}
                        >
                          {column.header}
                          <Icon className="size-3" aria-hidden />
                        </button>
                      ) : (
                        column.header
                      )}
                    </th>
                  );
                })}
                <th scope="col" className="h-10 w-16 px-3 text-right text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  View
                </th>
              </tr>
            </thead>

            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + 1} className="px-3 py-10 text-center text-sm text-muted-foreground">
                    {rows.length === 0 ? emptyMessage : 'Nothing matches that search.'}
                  </td>
                </tr>
              ) : (
                visible.map((item) => (
                  <tr
                    key={item.key}
                    tabIndex={0}
                    className="cursor-pointer border-b outline-none transition-colors last:border-0 hover:bg-accent/40 focus-visible:bg-accent/60"
                    onClick={() => openListing(item.fsn)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openListing(item.fsn);
                      }
                    }}
                    title={`Open listing ${item.fsn} in Flipkart Seller Hub`}
                  >
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={cn(
                          'max-w-[18rem] px-3 py-2 align-middle',
                          column.align === 'right' && 'tabular text-right',
                        )}
                      >
                        {column.cell(item)}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-muted-foreground hover:text-foreground"
                        onClick={(event) => {
                          // The row itself opens Seller Hub — the eye stays the
                          // way into the detail dialog.
                          event.stopPropagation();
                          onView(item);
                        }}
                        aria-label={`View details for ${item.sku}`}
                      >
                        <Eye className="size-4" />
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Rows per page</span>
          <Select value={String(pageSize)} onValueChange={(value) => setPageSize(Number(value))}>
            <SelectTrigger className="h-8 w-[5.5rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <span className="tabular text-xs text-muted-foreground">
            Page {current + 1} of {pageCount}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPage(current - 1)}
            disabled={current === 0}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPage(current + 1)}
            disabled={current >= pageCount - 1}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
