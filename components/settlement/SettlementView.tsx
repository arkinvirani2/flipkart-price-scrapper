'use client';

import { CircleCheck, CircleHelp, TrendingDown } from 'lucide-react';
import { useMemo } from 'react';
import { RowStatusBadge } from '@/components/dashboard/StatusBadge';
import { EMPTY_FILTERS } from '@/components/queue/FilterBar';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useJobRows } from '@/hooks/useJobRows';
import {
  formatDifference,
  formatDifferencePercent,
  formatDuration,
  formatPrice,
  formatSettlement,
} from '@/lib/format';
import { computeSettlement } from '@/lib/settlement';
import { cn } from '@/lib/utils';
import { SettlementTable, type SettlementColumn, type SettlementRow } from './SettlementTable';

/**
 * The settlement view.
 *
 * Reads the same unfiltered rows query the queue tab uses, so the SSE row-patch
 * keeps all three lists live during a run without any extra plumbing. Every row
 * is bucketed once into Main (clears the threshold), Below Threshold (falls
 * short) or Needs Review (can't be evaluated yet), and each bucket renders the
 * same column set — the review list adds a Reason column.
 */

const BASE_COLUMNS: SettlementColumn[] = [
  { key: 'sellerPrice', header: 'Seller Price', width: 6, align: 'right', cell: ({ settlement }) => formatPrice(settlement.sellerPrice) },
  { key: 'currentPrice', header: 'Current Price', width: 6, align: 'right', cell: ({ settlement }) => formatPrice(settlement.currentPrice) },
  { key: 'fsn', header: 'FSN', width: 9, cell: ({ row }) => <span title={row.fsn}>{row.fsn}</span> },
  { key: 'seller', header: 'Seller', width: 9, cell: ({ row }) => <span title={row.targetSeller}>{row.targetSeller}</span> },
  { key: 'status', header: 'Status', width: 6, cell: ({ row }) => <RowStatusBadge status={row.status} /> },
  { key: 'duration', header: 'Duration', width: 5, align: 'right', cell: ({ row }) => formatDuration(row.durationMs) },
  {
    key: 'difference',
    header: 'Difference',
    width: 6,
    align: 'right',
    cell: ({ settlement }) => <span className={signClass(settlement.difference)}>{formatDifference(settlement.difference)}</span>,
  },
  {
    key: 'differencePct',
    header: 'Diff %',
    width: 6,
    align: 'right',
    cell: ({ settlement }) => <span className={signClass(settlement.difference)}>{formatDifferencePercent(settlement.differencePct)}</span>,
  },
  { key: 'threshold', header: 'Threshold BS', width: 6.5, align: 'right', cell: ({ settlement }) => formatSettlement(settlement.bankSettlementThreshold) },
  { key: 'currentBs', header: 'Current BS', width: 6.5, align: 'right', cell: ({ settlement }) => formatSettlement(settlement.currentBankSettlement) },
  {
    key: 'finalBs',
    header: 'Final BS',
    width: 6.5,
    align: 'right',
    cell: ({ settlement }) => <span className="font-medium">{formatSettlement(settlement.finalBankSettlement)}</span>,
  },
];

const REASON_COLUMN: SettlementColumn = {
  key: 'reason',
  header: 'Reason',
  width: 14,
  cell: ({ settlement }) => (
    <span className="text-muted-foreground" title={settlement.reason ?? undefined}>
      {settlement.reason ?? '—'}
    </span>
  ),
};

const REVIEW_COLUMNS = [...BASE_COLUMNS, REASON_COLUMN];

export function SettlementView({ jobId }: { jobId: string }) {
  const rowsQuery = useJobRows(jobId, EMPTY_FILTERS);
  const rows = rowsQuery.data?.rows;

  const { main, below, review } = useMemo(() => {
    const main: SettlementRow[] = [];
    const below: SettlementRow[] = [];
    const review: SettlementRow[] = [];

    for (const row of rows ?? []) {
      const entry: SettlementRow = { row, settlement: computeSettlement(row) };
      if (entry.settlement.category === 'main') main.push(entry);
      else if (entry.settlement.category === 'below') below.push(entry);
      else review.push(entry);
    }

    return { main, below, review };
  }, [rows]);

  if (rowsQuery.isLoading && !rows) {
    return <Skeleton className="h-96 w-full" />;
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Difference is <span className="font-medium text-foreground">current price − seller price</span>; final bank
        settlement is <span className="font-medium text-foreground">current bank settlement + difference</span>. Click
        any row to open its listing in Flipkart Seller Hub.
      </p>

      <Tabs defaultValue="main" className="space-y-3">
        <TabsList>
          <TabsTrigger value="main">
            <CircleCheck className="mr-1.5 size-4" />
            Main list
            <CountBadge value={main.length} />
          </TabsTrigger>
          <TabsTrigger value="below">
            <TrendingDown className="mr-1.5 size-4" />
            Below threshold
            <CountBadge value={below.length} />
          </TabsTrigger>
          <TabsTrigger value="review">
            <CircleHelp className="mr-1.5 size-4" />
            Needs review
            <CountBadge value={review.length} />
          </TabsTrigger>
        </TabsList>

        <TabsContent value="main" className="mt-0 space-y-2">
          <p className="text-xs text-muted-foreground">Final bank settlement meets or beats the threshold.</p>
          <SettlementTable rows={main} columns={BASE_COLUMNS} emptyMessage="No listings clear their threshold yet." />
        </TabsContent>

        <TabsContent value="below" className="mt-0 space-y-2">
          <p className="text-xs text-muted-foreground">Final bank settlement falls short of the threshold.</p>
          <SettlementTable rows={below} columns={BASE_COLUMNS} emptyMessage="No listings are below their threshold." />
        </TabsContent>

        <TabsContent value="review" className="mt-0 space-y-2">
          <p className="text-xs text-muted-foreground">
            Can&apos;t be settlement-evaluated — the reason is on each row.
          </p>
          <SettlementTable rows={review} columns={REVIEW_COLUMNS} emptyMessage="Every scraped row could be evaluated." />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** The little count pill shown after each sub-tab label. */
function CountBadge({ value }: { value: number }) {
  return (
    <span className="tabular ml-1.5 rounded-full bg-muted-foreground/15 px-1.5 text-[11px] leading-5 text-muted-foreground">
      {value}
    </span>
  );
}

/** No colour for a flat difference; positive and negative just get emphasis via the sign. */
function signClass(value: number | null): string {
  return cn('tabular', value !== null && value !== 0 && 'font-medium');
}
