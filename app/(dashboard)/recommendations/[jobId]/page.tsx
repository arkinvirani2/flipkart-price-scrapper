'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  CircleHelp,
  Download,
  FileSpreadsheet,
  Loader2,
  Package,
  RefreshCw,
  ShieldAlert,
  Store,
  Tag,
  Trophy,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  ALREADY_CORRECT_COLUMNS,
  BUYBOX_NO_ORDERS_COLUMNS,
  BUYBOX_WON_COLUMNS,
  MY_LISTING_COLUMNS,
  NEEDS_REVIEW_COLUMNS,
  PRICE_CHANGE_COLUMNS,
  RecommendationTable,
  SETTLEMENT_UNSAFE_COLUMNS,
} from '@/components/recommendations/RecommendationTable';
import { RecommendationDetailDialog } from '@/components/recommendations/RecommendationDetailDialog';
import { SupportTicketMessage } from '@/components/recommendations/SupportTicketMessage';
import { StatCard } from '@/components/dashboard/StatCard';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { Recommendation } from '@/lib/recommendation';

/**
 * The recommendation page for one upload.
 *
 * It reads the recommendations saved in the job folder and never recomputes
 * them on the way in — opening last Tuesday's upload shows the decision that was
 * made last Tuesday, against the history as it stood then. Regenerating is a
 * button, because that is a different thing from looking.
 */

export default function RecommendationsPage() {
  const params = useParams<{ jobId: string }>();
  const jobId = params.jobId;
  const queryClient = useQueryClient();

  const [detail, setDetail] = useState<Recommendation | null>(null);
  const [search, setSearch] = useState('');

  const query = useQuery({
    queryKey: ['recommendations', jobId],
    queryFn: () => api.recommendations(jobId),
  });

  const regenerate = useMutation({
    mutationFn: () => api.regenerateRecommendations(jobId),
    onSuccess: (data) => {
      queryClient.setQueryData(['recommendations', jobId], data);
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });

  const file = query.data?.recommendations;

  const buckets = useMemo(() => {
    const empty = {
      priceChange: [] as Recommendation[],
      alreadyCorrect: [] as Recommendation[],
      settlementUnsafe: [] as Recommendation[],
      buyboxWon: [] as Recommendation[],
      needsReview: [] as Recommendation[],
      myListing: [] as Recommendation[],
    };
    for (const item of file?.recommendations ?? []) empty[item.category].push(item);
    return empty;
  }, [file]);

  /**
   * The Buy Box lists, split by whether the product actually sold.
   *
   * Two different scenarios wearing one label: holding the Buy Box on something
   * that is selling is a result, holding it on something nobody bought is a
   * question. Purely a presentation split — the same rows, the same rules,
   * sorted by the 24h order count the rules already recorded.
   *
   * Selected on `hasBuybox` rather than out of the buyboxWon bucket, because a
   * Buy Box row that came back with a recommended price is filed under Price
   * change — that is what makes it actionable and exportable — and it would
   * otherwise be missing from the very list that explains why it has one. So a
   * priced row appears in both, answering a different question in each. Rows from
   * a batch with no orders report have no count at all, and sit with the ones
   * that sold nothing because that is the list you go looking for them in.
   */
  const buybox = useMemo(() => {
    const won = (file?.recommendations ?? []).filter((item) => item.hasBuybox === true);
    return {
      selling: won.filter((item) => (item.ordersLast24h ?? 0) > 0),
      noOrders: won.filter((item) => (item.ordersLast24h ?? 0) <= 0),
    };
  }, [file]);

  if (query.isLoading) {
    return (
      <div className="w-full space-y-4 p-4 xl:p-5">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (query.isError || !file) {
    return (
      <div className="w-full p-4 xl:p-5">
        <Alert variant="destructive">
          <AlertTitle>Could not load recommendations</AlertTitle>
          <AlertDescription>
            {query.error instanceof Error ? query.error.message : 'This upload has no recommendations.'}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const counts = file.counts;
  // The search box mirrors into the export link, so the file matches the table.
  const exportHref = (format: 'csv' | 'xlsx') => {
    const exportParams = new URLSearchParams({ format });
    if (search.trim()) exportParams.set('search', search.trim());
    return `/api/jobs/${jobId}/recommendations/export?${exportParams.toString()}`;
  };

  return (
    <div className="w-full space-y-5 p-4 xl:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/" aria-label="Back to uploads">
              <ArrowLeft />
            </Link>
          </Button>
          <div>
            <h1 className="text-xl font-semibold">Recommendations — {file.jobName}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{file.summary}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/jobs/${jobId}`}>Open batch</Link>
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={() => regenerate.mutate()}
                disabled={regenerate.isPending}
              >
                {regenerate.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                Regenerate
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Re-runs the rules against this account&apos;s history as it stands now, and overwrites
              the saved recommendations for this upload.
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {regenerate.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not regenerate</AlertTitle>
          <AlertDescription>{(regenerate.error as Error).message}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Account</p>
          <p className="mt-2 truncate text-lg font-semibold leading-tight" title={file.accountName}>
            {file.accountName || '—'}
          </p>
          <p className="mt-1.5 truncate text-xs text-muted-foreground">
            {file.historyJobs} previous upload{file.historyJobs === 1 ? '' : 's'} used as history
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Upload time</p>
          <p className="tabular mt-2 text-lg font-semibold leading-tight">{formatDateTime(file.uploadTime)}</p>
          <p className="mt-1.5 truncate text-xs text-muted-foreground">
            Generated {formatDateTime(file.generatedAt)}
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Orders window
          </p>
          <p className="tabular mt-2 text-lg font-semibold leading-tight">
            {file.ordersWindow ? `${file.ordersWindow.observedDays.toFixed(1)} days` : 'None'}
          </p>
          <p className="mt-1.5 truncate text-xs text-muted-foreground">
            {file.ordersWindow
              ? `${file.ordersWindow.units.toLocaleString('en-IN')} units to ${formatDateTime(
                  file.ordersWindow.end,
                )}`
              : 'No orders report — Buy Box rows were left alone'}
          </p>
        </Card>

        <StatCard label="Total SKU" value={counts.total} icon={Package} />
        <StatCard label="Price change required" value={counts.priceChange} icon={Tag} tone="running" />
        <StatCard label="Already correct" value={counts.alreadyCorrect} icon={CheckCircle2} tone="success" />
        <StatCard label="Settlement unsafe" value={counts.settlementUnsafe} icon={ShieldAlert} tone="failed" />
        <StatCard label="Buy Box won" value={counts.buyboxWon} icon={Trophy} tone="success" />
      </div>

      {counts.needsReview > 0 && (
        <Alert variant="warning">
          <CircleHelp />
          <AlertTitle>
            {counts.needsReview} SKU{counts.needsReview === 1 ? '' : 's'} could not be evaluated
          </AlertTitle>
          <AlertDescription>
            They were never scraped, failed, or came back without prices, so no rule could be applied.
            They are listed in the Needs review tab.
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="priceChange" className="space-y-3">
        <TabsList>
          <TabsTrigger value="priceChange">
            <Tag className="mr-1.5 size-4" />
            Price change
            <CountBadge value={counts.priceChange} />
          </TabsTrigger>
          <TabsTrigger value="alreadyCorrect">
            <CheckCircle2 className="mr-1.5 size-4" />
            Already correct
            <CountBadge value={counts.alreadyCorrect} />
          </TabsTrigger>
          <TabsTrigger value="settlementUnsafe">
            <ShieldAlert className="mr-1.5 size-4" />
            Settlement unsafe
            <CountBadge value={counts.settlementUnsafe} />
          </TabsTrigger>
          <TabsTrigger value="buyboxSelling">
            <Trophy className="mr-1.5 size-4" />
            Buy Box won — selling
            <CountBadge value={buybox.selling.length} />
          </TabsTrigger>
          <TabsTrigger value="buyboxNoOrders">
            <Trophy className="mr-1.5 size-4" />
            Buy Box won — no orders
            <CountBadge value={buybox.noOrders.length} />
          </TabsTrigger>
          {buckets.myListing.length > 0 && (
            <TabsTrigger value="myListing">
              <Store className="mr-1.5 size-4" />
              My Listing
              <CountBadge value={buckets.myListing.length} />
            </TabsTrigger>
          )}
          {counts.needsReview > 0 && (
            <TabsTrigger value="needsReview">
              <CircleHelp className="mr-1.5 size-4" />
              Needs review
              <CountBadge value={counts.needsReview} />
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="priceChange" className="mt-0 space-y-2">
          <p className="text-xs text-muted-foreground">
            The actionable list: a lower price that wins the Buy Box and still settles above the
            minimum, or a higher one where the winner is dearer than us and the margin is going
            unclaimed. This is the only tab that exports.
          </p>
          <RecommendationTable
            rows={buckets.priceChange}
            columns={PRICE_CHANGE_COLUMNS}
            emptyMessage="No price changes are recommended for this upload."
            onView={setDetail}
            onSearchChange={setSearch}
            actions={
              <div className="flex gap-2">
                <Button variant="outline" size="sm" asChild>
                  <a href={exportHref('csv')} download>
                    <Download /> CSV
                  </a>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <a href={exportHref('xlsx')} download>
                    <FileSpreadsheet /> XLSX
                  </a>
                </Button>
              </div>
            }
          />
        </TabsContent>

        <TabsContent value="alreadyCorrect" className="mt-0 space-y-2">
          <p className="text-xs text-muted-foreground">
            Already at the winner price, with the Buy Box going elsewhere — the Change is zero and
            there is nothing to edit.
          </p>
          <RecommendationTable
            rows={buckets.alreadyCorrect}
            columns={ALREADY_CORRECT_COLUMNS}
            emptyMessage="No SKUs are already at the right price."
            onView={setDetail}
          />
        </TabsContent>

        <TabsContent value="settlementUnsafe" className="mt-0 space-y-2">
          <p className="text-xs text-muted-foreground">
            Matching the winner would push the settlement below the minimum, so no price is recommended
            — plus the rows where we hold the Buy Box but the bank-settlement values are missing, which
            show what the normal calculation would have recommended for checking by hand.
          </p>
          <RecommendationTable
            rows={buckets.settlementUnsafe}
            columns={SETTLEMENT_UNSAFE_COLUMNS}
            emptyMessage="Every recommendation stayed above its minimum settlement."
            onView={setDetail}
          />
        </TabsContent>

        <TabsContent value="buyboxSelling" className="mt-0 space-y-2">
          <p className="text-xs text-muted-foreground">
            We hold the Buy Box and the product sold in the last 24 hours — the price is working, so
            leave it alone.
          </p>
          <RecommendationTable
            rows={buybox.selling}
            columns={BUYBOX_WON_COLUMNS}
            emptyMessage="No Buy Box win sold anything in the last 24 hours."
            onView={setDetail}
          />
        </TabsContent>

        <TabsContent value="buyboxNoOrders" className="mt-0 space-y-2">
          <p className="text-xs text-muted-foreground">
            We hold the Buy Box but nothing sold in the last 24 hours. The benchmark is checked
            first: where it still clears the minimum bank settlement once fees come off, it is the
            recommended price; where it does not, the zero-order rules decide. Every figure here is
            measured from the recommended price, because on these rows the winner is us.
          </p>
          <RecommendationTable
            rows={buybox.noOrders}
            columns={BUYBOX_NO_ORDERS_COLUMNS}
            emptyMessage="Every Buy Box win sold at least one unit."
            onView={setDetail}
          />
        </TabsContent>

        {buckets.myListing.length > 0 && (
          <TabsContent value="myListing" className="mt-0 space-y-2">
            <p className="text-xs text-muted-foreground">
              Products where the Buy Box is ours because nobody else lists them. There is no
              competitor to match, so the price is led by Flipkart&apos;s benchmark and floored by
              the minimum settlement.
            </p>
            <RecommendationTable
              rows={buckets.myListing}
              columns={MY_LISTING_COLUMNS}
              emptyMessage="No sole-seller listings in this batch."
              onView={setDetail}
            />
          </TabsContent>
        )}

        {counts.needsReview > 0 && (
          <TabsContent value="needsReview" className="mt-0 space-y-2">
            <p className="text-xs text-muted-foreground">
              No rule could be applied — the reason is on each row.
            </p>
            <SupportTicketMessage items={buckets.needsReview} />
            <RecommendationTable
              rows={buckets.needsReview}
              columns={NEEDS_REVIEW_COLUMNS}
              emptyMessage="Every SKU could be evaluated."
              onView={setDetail}
            />
          </TabsContent>
        )}
      </Tabs>

      <RecommendationDetailDialog item={detail} onOpenChange={(open) => !open && setDetail(null)} />
    </div>
  );
}

function CountBadge({ value }: { value: number }) {
  return (
    <span className="tabular ml-1.5 rounded-full bg-muted-foreground/15 px-1.5 text-[11px] leading-5 text-muted-foreground">
      {value}
    </span>
  );
}
