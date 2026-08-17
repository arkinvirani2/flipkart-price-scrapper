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
import { RULE_LABEL, type Recommendation } from '@/lib/recommendation';
import { sellerListingUrl } from '@/lib/settlement';
import { cn } from '@/lib/utils';

/**
 * The recommendation list for one tab.
 *
 * Paginated rather than virtualized, unlike the queue: a recommendation list is
 * something you work through in order and tick off, so a page number is a more
 * useful position than a scroll offset. Search, sort and page size all live in
 * this component's own state, so switching tabs starts each list clean.
 *
 * As in the settlement table, clicking a row opens that product's Flipkart
 * Seller Hub listing in a new tab, so the price can be changed where it is
 * recommended. The View button stays a separate action for the detail dialog.
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

/** Columns every tab shows. */
const IDENTITY_COLUMNS: SortableColumn[] = [
  {
    key: 'sku',
    header: 'SKU',
    sortValue: (item) => item.sku,
    cell: (item) => (
      <span className="block truncate font-medium" title={item.sku}>
        {item.sku}
      </span>
    ),
  },
  {
    key: 'fsn',
    header: 'FSN',
    sortValue: (item) => item.fsn,
    cell: (item) => (
      <span className="block truncate text-muted-foreground" title={item.fsn}>
        {item.fsn}
      </span>
    ),
  },
];

const PRICE_COLUMNS: SortableColumn[] = [
  {
    key: 'currentPrice',
    header: 'Current price',
    align: 'right',
    sortValue: (item) => item.currentPrice,
    cell: (item) => formatPrice(item.currentPrice),
  },
  {
    key: 'winnerPrice',
    header: 'Winner price',
    align: 'right',
    sortValue: (item) => item.winnerPrice,
    cell: (item) => formatPrice(item.winnerPrice),
  },
];

const WINNER_COLUMN: SortableColumn = {
  key: 'winningSeller',
  header: 'Winning seller',
  sortValue: (item) => item.winningSeller,
  cell: (item) =>
    item.winningSeller ? (
      <span className="block truncate" title={item.winningSeller}>
        {item.winningSeller}
      </span>
    ) : (
      <span className="text-muted-foreground">—</span>
    ),
};

/** Flipkart's own competitive read. Zero is "no benchmark", never a price. */
const BENCHMARK_COLUMN: SortableColumn = {
  key: 'benchmarkPrice',
  header: 'Benchmark',
  align: 'right',
  sortValue: (item) => item.benchmarkPrice,
  cell: (item) =>
    item.benchmarkPrice ? (
      formatPrice(item.benchmarkPrice)
    ) : (
      <span className="text-muted-foreground" title="Flipkart published no benchmark for this FSN">
        —
      </span>
    ),
};

/** The zero-order test, and how much weight it carries. */
const DEMAND_COLUMNS: SortableColumn[] = [
  {
    key: 'ordersLast24h',
    header: '24h orders',
    align: 'right',
    sortValue: (item) => item.ordersLast24h,
    cell: (item) =>
      item.ordersLast24h === null ? (
        <span className="text-muted-foreground" title="No orders report was uploaded with this batch">
          —
        </span>
      ) : (
        <span className={cn(item.ordersLast24h === 0 && 'font-medium text-status-failed')}>
          {item.ordersLast24h}
        </span>
      ),
  },
  {
    key: 'historicalUnitsPerDay',
    header: 'Normal / day',
    align: 'right',
    sortValue: (item) => item.historicalUnitsPerDay,
    cell: (item) =>
      item.historicalUnitsPerDay === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        item.historicalUnitsPerDay.toFixed(2)
      ),
  },
  {
    key: 'confidence',
    header: 'Confidence',
    align: 'right',
    sortValue: (item) => item.confidence,
    // Only the Buy Box layer grades itself, so a bare 100% from a deterministic
    // rule would read as a measurement it never took.
    cell: (item) =>
      item.demand ? (
        `${Math.round(item.confidence * 100)}%`
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
];

const REASON_COLUMN: SortableColumn = {
  key: 'reason',
  header: 'Reason',
  sortValue: (item) => item.reason,
  cell: (item) => (
    <span className="block truncate text-muted-foreground" title={item.reason}>
      {item.reason}
    </span>
  ),
};

const SETTLEMENT_COLUMNS: SortableColumn[] = [
  {
    key: 'currentSettlement',
    header: 'Current settlement',
    align: 'right',
    sortValue: (item) => item.currentSettlement,
    cell: (item) => formatSettlement(item.currentSettlement),
  },
  {
    key: 'minSettlement',
    header: 'Minimum settlement',
    align: 'right',
    sortValue: (item) => item.minSettlement,
    cell: (item) => formatSettlement(item.minSettlement),
  },
];

/** Column sets per tab — each one shows the figures that tab is actually about. */
export const PRICE_CHANGE_COLUMNS: SortableColumn[] = [
  ...IDENTITY_COLUMNS,
  ...PRICE_COLUMNS,
  BENCHMARK_COLUMN,
  {
    key: 'recommendedPrice',
    header: 'Recommended',
    align: 'right',
    sortValue: (item) => item.recommendedPrice,
    cell: (item) => <span className="font-semibold text-status-success">{formatPrice(item.recommendedPrice)}</span>,
  },
  {
    key: 'priceDelta',
    header: 'Change',
    align: 'right',
    sortValue: (item) => item.priceDelta,
    cell: (item) => <span className="font-medium">{formatSignedNumber(item.priceDelta)}</span>,
  },
  {
    key: 'projectedSettlement',
    header: 'Projected settlement',
    align: 'right',
    sortValue: (item) => item.projectedSettlement,
    cell: (item) => formatSettlement(item.projectedSettlement),
  },
  {
    key: 'minSettlement',
    header: 'Minimum settlement',
    align: 'right',
    sortValue: (item) => item.minSettlement,
    cell: (item) => formatSettlement(item.minSettlement),
  },
  ...DEMAND_COLUMNS,
  {
    key: 'rule',
    header: 'Rule',
    sortValue: (item) => item.rule,
    cell: (item) => (
      <span className="block truncate text-xs text-muted-foreground" title={RULE_LABEL[item.rule]}>
        {RULE_LABEL[item.rule]}
      </span>
    ),
  },
];

export const ALREADY_CORRECT_COLUMNS: SortableColumn[] = [
  ...IDENTITY_COLUMNS,
  ...PRICE_COLUMNS,
  WINNER_COLUMN,
  REASON_COLUMN,
];

export const SETTLEMENT_UNSAFE_COLUMNS: SortableColumn[] = [
  ...IDENTITY_COLUMNS,
  ...PRICE_COLUMNS,
  ...SETTLEMENT_COLUMNS,
  {
    key: 'projectedSettlement',
    header: 'Would settle at',
    align: 'right',
    sortValue: (item) => item.projectedSettlement,
    cell: (item) => <span className="text-status-failed">{formatSettlement(item.projectedSettlement)}</span>,
  },
  REASON_COLUMN,
];

export const BUYBOX_WON_COLUMNS: SortableColumn[] = [
  ...IDENTITY_COLUMNS,
  ...PRICE_COLUMNS,
  BENCHMARK_COLUMN,
  ...DEMAND_COLUMNS,
  {
    key: 'buyboxWins',
    header: 'Past wins',
    align: 'right',
    sortValue: (item) => item.history.buyboxWins,
    cell: (item) =>
      item.history.uploads === 0 ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        `${item.history.buyboxWins}/${item.history.uploads}`
      ),
  },
  REASON_COLUMN,
];

export const NEEDS_REVIEW_COLUMNS: SortableColumn[] = [...IDENTITY_COLUMNS, ...PRICE_COLUMNS, REASON_COLUMN];

interface Props {
  rows: Recommendation[];
  columns: SortableColumn[];
  emptyMessage: string;
  onView: (item: Recommendation) => void;
  /** Rendered next to the search box — the export buttons on the Price Change tab. */
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
      [item.sku, item.fsn, item.winningSeller, item.reason, item.accountName, item.reasonCode]
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
            placeholder="Search SKU, FSN, seller or reason…"
            className="pl-8"
            aria-label="Search recommendations"
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
