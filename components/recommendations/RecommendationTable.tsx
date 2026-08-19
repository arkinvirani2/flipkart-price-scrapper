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
import {
  currentListingPrice,
  expectedBankSettlement,
  expectedListingPrice,
  expectedListingPriceAtRecommendation,
  priceDifference,
  settlementUnsafeTarget,
  RULE_LABEL,
  type Recommendation,
} from '@/lib/recommendation';
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

/**
 * Do we hold the Buy Box on this listing?
 *
 * Null is not No. It means Flipkart never named a winning seller for the page,
 * so the question was never answered — printing "No" there would invent a loss
 * that was never observed.
 */
const BUYBOX_COLUMN: SortableColumn = {
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

/**
 * Columns every tab shows.
 *
 * The FSN alone identifies the row — it is what the Seller Hub link is built
 * from and what the user searches by. The SKU is still searchable and still
 * names the detail dialog; it just no longer takes a column.
 */
const IDENTITY_COLUMNS: SortableColumn[] = [
  {
    key: 'fsn',
    header: 'FSN',
    sortValue: (item) => item.fsn,
    cell: (item) => (
      <span className="block truncate font-medium" title={item.fsn}>
        {item.fsn}
      </span>
    ),
  },
  BUYBOX_COLUMN,
];

/**
 * The price Flipkart shows for *our own* listing, as scraped.
 *
 * Headed by what it is rather than "Current price": the sheet's own current
 * listing price sits in the next column along, and the two are different
 * numbers that must never be read as each other.
 */
const FLIPKART_DISPLAYED_COLUMN: SortableColumn = {
  key: 'currentPrice',
  header: 'Flipkart displayed price',
  align: 'right',
  sortValue: (item) => item.currentPrice,
  cell: (item) => formatPrice(item.currentPrice),
};

const WINNER_PRICE_COLUMN: SortableColumn = {
  key: 'winnerPrice',
  header: 'Winner price',
  align: 'right',
  sortValue: (item) => item.winnerPrice,
  cell: (item) => formatPrice(item.winnerPrice),
};

const PRICE_COLUMNS: SortableColumn[] = [FLIPKART_DISPLAYED_COLUMN, WINNER_PRICE_COLUMN];

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

/** Units sold in the last 24 hours, from the orders report. */
const ORDERS_COLUMN: SortableColumn = {
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
};

/** The zero-order test, and how much weight it carries. */
const DEMAND_COLUMNS: SortableColumn[] = [
  ORDERS_COLUMN,
  {
    key: 'historicalUnitsPerDay',
    header: 'Normal / day',
    align: 'right',
    sortValue: (item) => item.historicalUnitsPerDay,
    cell: (item) =>
      item.historicalUnitsPerDay === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        item.historicalUnitsPerDay?.toFixed(2)
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

/** The sheet's own listing price — the number the seller actually edits. */
const CURRENT_LISTING_PRICE_COLUMN: SortableColumn = {
  key: 'currentListingPrice',
  header: 'Current listing price',
  align: 'right',
  sortValue: (item) => currentListingPrice(item),
  cell: (item) => formatPrice(currentListingPrice(item)),
};

/**
 * The calculation behind a recommendation, spelled out.
 *
 *     Difference             = winner price − Flipkart displayed price
 *     Expected listing price = current listing price   + difference
 *     Expected bank settlt.  = current bank settlement + difference
 *
 * Shared between the Price change tab and the Already correct tab so a reviewer
 * reads the same figures on both, rather than being shown a conclusion on one
 * and the workings on the other.
 */
const CALCULATION_COLUMNS: SortableColumn[] = [
  CURRENT_LISTING_PRICE_COLUMN,
  FLIPKART_DISPLAYED_COLUMN,
  WINNER_PRICE_COLUMN,
  BENCHMARK_COLUMN,
  {
    key: 'difference',
    header: 'Change',
    align: 'right',
    sortValue: (item) => priceDifference(item),
    cell: (item) => <span className="font-medium">{formatSignedNumber(priceDifference(item))}</span>,
  },
  {
    key: 'expectedListingPrice',
    header: 'Expected listing price',
    align: 'right',
    sortValue: (item) => expectedListingPrice(item),
    cell: (item) => (
      <span className="font-semibold text-status-success">{formatPrice(expectedListingPrice(item))}</span>
    ),
  },
  {
    key: 'expectedBankSettlement',
    header: 'Expected bank settlement',
    align: 'right',
    sortValue: (item) => expectedBankSettlement(item),
    // Same treatment as the expected price beside it: the two "expected" figures
    // are one pair, read off the same Difference.
    cell: (item) => (
      <span className="font-semibold text-status-success">{formatSettlement(expectedBankSettlement(item))}</span>
    ),
  },
  {
    key: 'minSettlement',
    header: 'Minimum bank settlement',
    align: 'right',
    sortValue: (item) => item.minSettlement,
    cell: (item) => formatSettlement(item.minSettlement),
  },
];

/** Column sets per tab — each one shows the figures that tab is actually about. */
export const PRICE_CHANGE_COLUMNS: SortableColumn[] = [
  ...IDENTITY_COLUMNS,
  ...CALCULATION_COLUMNS,
  {
    // The price to actually type into Seller Hub. Usually the winner price, so
    // the Change beside it explains it — but not always: rules 6, 7, 13 and the
    // learned predictor all set a price the winner alone does not account for,
    // and a Buy Box row priced off the benchmark has no winner gap at all.
    key: 'recommendedPrice',
    header: 'Recommended price',
    align: 'right',
    sortValue: (item) => item.recommendedPrice,
    cell: (item) => <span className="font-semibold">{formatPrice(item.recommendedPrice)}</span>,
  },
  WINNER_COLUMN,
  {
    // Not the Expected bank settlement above: that one answers "where does the
    // Difference put the settlement?", this one answers "where would the price
    // this tab is recommending put it?" — the figure the minimum-settlement gate
    // is actually judged on.
    key: 'projectedSettlement',
    header: 'Settlement at recommended price',
    align: 'right',
    sortValue: (item) => item.projectedSettlement,
    cell: (item) => formatSettlement(item.projectedSettlement),
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
  ...CALCULATION_COLUMNS,
  WINNER_COLUMN,
  ORDERS_COLUMN,
  REASON_COLUMN,
];

/**
 * The Settlement unsafe list.
 *
 * The winner price is shown because it is why the row is here, but nothing is
 * derived from it: matching it would settle under the minimum. The Change and
 * both expected figures come from `settlementUnsafeTarget` instead — Flipkart's
 * benchmark where it still clears the minimum settlement once fees come off, and
 * the floor itself where it does not. The Benchmark column sits next to the
 * Change so the substitution can be read off the row.
 */
export const SETTLEMENT_UNSAFE_COLUMNS: SortableColumn[] = [
  ...IDENTITY_COLUMNS,
  CURRENT_LISTING_PRICE_COLUMN,
  ...PRICE_COLUMNS,
  WINNER_COLUMN,
  BENCHMARK_COLUMN,
  {
    key: 'settlementUnsafeChange',
    header: 'Change',
    align: 'right',
    sortValue: (item) => settlementUnsafeTarget(item).change,
    cell: (item) => {
      const derived = settlementUnsafeTarget(item);
      return (
        <span
          className="font-medium"
          title={
            derived.benchmarkUsable
              ? 'Derived from the benchmark price, which still clears the minimum bank settlement'
              : 'Derived from the price floor: minimum bank settlement + fees'
          }
        >
          {formatSignedNumber(derived.change)}
        </span>
      );
    },
  },
  {
    key: 'settlementUnsafeExpectedListingPrice',
    header: 'Expected listing price',
    align: 'right',
    sortValue: (item) => settlementUnsafeTarget(item).expectedListingPrice,
    cell: (item) => formatPrice(settlementUnsafeTarget(item).expectedListingPrice),
  },
  {
    key: 'settlementUnsafeExpectedBankSettlement',
    header: 'Expected bank settlement',
    align: 'right',
    sortValue: (item) => settlementUnsafeTarget(item).expectedBankSettlement,
    cell: (item) => formatSettlement(settlementUnsafeTarget(item).expectedBankSettlement),
  },
  ...SETTLEMENT_COLUMNS,
  {
    // The settlement the *winner* price would have produced — the figure that
    // put this row on this list, kept apart from the expected one above.
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

/**
 * The Buy Box list for rows that sold nothing.
 *
 * Same shape as the Price change tab, but every derived figure is measured from
 * the recommended price rather than from the winner: we *are* the winner here,
 * so a winner-based Change would read zero on every row. The benchmark sits next
 * to the Change it produced, and the minimum bank settlement next to the
 * settlement that has to clear it.
 */
export const BUYBOX_NO_ORDERS_COLUMNS: SortableColumn[] = [
  ...IDENTITY_COLUMNS,
  CURRENT_LISTING_PRICE_COLUMN,
  ...PRICE_COLUMNS,
  BENCHMARK_COLUMN,
  {
    key: 'recommendedPrice',
    header: 'Recommended price',
    align: 'right',
    sortValue: (item) => item.recommendedPrice,
    cell: (item) =>
      item.recommendedPrice === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <span className="font-semibold">{formatPrice(item.recommendedPrice)}</span>
      ),
  },
  {
    key: 'priceDelta',
    header: 'Change',
    align: 'right',
    sortValue: (item) => item.priceDelta,
    cell: (item) => <span className="font-medium">{formatSignedNumber(item.priceDelta)}</span>,
  },
  {
    key: 'expectedListingPriceAtRecommendation',
    header: 'Expected listing price',
    align: 'right',
    sortValue: (item) => expectedListingPriceAtRecommendation(item),
    cell: (item) => (
      <span className="font-semibold text-status-success">
        {formatPrice(expectedListingPriceAtRecommendation(item))}
      </span>
    ),
  },
  {
    // Already the settlement the recommended price produces, so it needs no
    // second derivation: projectedSettlement is currentSettlement + the Change.
    key: 'projectedSettlement',
    header: 'Expected bank settlement',
    align: 'right',
    sortValue: (item) => item.projectedSettlement,
    cell: (item) => (
      <span className="font-semibold text-status-success">{formatSettlement(item.projectedSettlement)}</span>
    ),
  },
  {
    key: 'minSettlement',
    header: 'Minimum bank settlement',
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
