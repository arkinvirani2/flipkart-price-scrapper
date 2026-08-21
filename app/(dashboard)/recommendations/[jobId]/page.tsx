'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, FileSpreadsheet, Loader2, Package, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  RecommendationTable,
  TAB_COLUMNS,
} from '@/components/recommendations/RecommendationTable';
import { RecommendationDetailDialog } from '@/components/recommendations/RecommendationDetailDialog';
import { StatCard } from '@/components/dashboard/StatCard';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import {
  CATEGORY_ORDER,
  RECOMMENDATION_CATEGORY_LABEL,
  type Recommendation,
  type RecommendationCategory,
} from '@/lib/recommendation';

/**
 * The recommendation page for one upload.
 *
 * The eight tabs are listed straight off `CATEGORY_ORDER`, in the order the
 * classification applies them, and each one shows only the records whose
 * category is its own. Because the classification already assigned every record
 * to at most one tab, nothing here can duplicate a row across two of them.
 *
 * The saved file is read as-is and never recomputed on the way in — opening last
 * Tuesday's upload shows the classification made last Tuesday. Regenerating is a
 * button, because that is a different thing from looking.
 */

/** The first tab is the actionable one, and the only one that exports. */
const EXPORTING_TAB: RecommendationCategory = 'priceChangeDiff';

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

  /** One list per tab, filled by the category the classification already set. */
  const buckets = useMemo(() => {
    const empty = Object.fromEntries(
      CATEGORY_ORDER.map((category) => [category, [] as Recommendation[]]),
    ) as Record<RecommendationCategory, Recommendation[]>;

    for (const item of file?.recommendations ?? []) {
      if (item.category !== null) empty[item.category].push(item);
    }
    return empty;
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
              Re-runs the eight filters against this upload&apos;s data as it stands now, and
              overwrites the saved result.
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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Seller</p>
          <p className="mt-2 truncate text-lg font-semibold leading-tight" title={file.accountName}>
            {file.accountName || '—'}
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
              : 'No orders report — the order count is unknown'}
          </p>
        </Card>

        <StatCard label="Total SKU" value={counts.total} icon={Package} />
      </div>

      <Tabs defaultValue={CATEGORY_ORDER[0]} className="space-y-3">
        {/* Eight tabs with full labels will not fit one line on most screens, so
            the list wraps. `h-auto` is the point of this override: TabsList is
            a fixed h-9 by default, and a wrapped second row inside a fixed
            height overflows the box and lands on the search field below. */}
        <TabsList className="h-auto flex-wrap justify-start gap-1">
          {CATEGORY_ORDER.map((category, position) => (
            <TabsTrigger key={category} value={category}>
              <span className="mr-1.5 text-muted-foreground">{position + 1}.</span>
              {RECOMMENDATION_CATEGORY_LABEL[category]}
              <CountBadge value={buckets[category].length} />
            </TabsTrigger>
          ))}
        </TabsList>

        {CATEGORY_ORDER.map((category) => (
          <TabsContent key={category} value={category} className="mt-0 space-y-2">
            <RecommendationTable
              rows={buckets[category]}
              columns={TAB_COLUMNS[category]}
              emptyMessage="No records fell into this tab."
              onView={setDetail}
              onSearchChange={category === EXPORTING_TAB ? setSearch : undefined}
              actions={
                category === EXPORTING_TAB ? (
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
                ) : undefined
              }
            />
          </TabsContent>
        ))}
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
