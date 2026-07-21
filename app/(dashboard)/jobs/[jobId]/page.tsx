'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { AnalyticsCharts } from '@/components/charts/AnalyticsCharts';
import { ControlBar } from '@/components/dashboard/ControlBar';
import { LiveProgressPanel } from '@/components/dashboard/LiveProgressPanel';
import { StatGrid } from '@/components/dashboard/StatGrid';
import { JobStateBadge } from '@/components/dashboard/StatusBadge';
import { FailedProducts } from '@/components/failed/FailedProducts';
import { LogViewer } from '@/components/logs/LogViewer';
import { EMPTY_FILTERS, FilterBar, type QueueFilters } from '@/components/queue/FilterBar';
import { ExportButtons } from '@/components/queue/ExportButtons';
import { QueueTable } from '@/components/queue/QueueTable';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useJobRows, filtersToParams } from '@/hooks/useJobRows';
import { useJobStream } from '@/hooks/useJobStream';
import { api } from '@/lib/api';
import { ACTIVE_STATES } from '@/types/dashboard';

export default function JobDetailPage() {
  const params = useParams<{ jobId: string }>();
  const jobId = params.jobId;
  const router = useRouter();

  const [banner, setBanner] = useState<string | null>(null);
  const [filters, setFilters] = useState<QueueFilters>(EMPTY_FILTERS);

  // Snapshot from the server; the SSE stream keeps state/stats/progress current.
  const detail = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.getJob(jobId),
  });

  const stream = useJobStream(jobId);
  const rowsQuery = useJobRows(jobId, filters);

  const manifest = detail.data?.job;
  const state = stream.state ?? manifest?.state ?? 'queued';
  const stats = stream.stats ?? detail.data?.stats ?? null;
  const isRunning = ACTIVE_STATES.includes(state);
  const blockedBy = detail.data?.activeJobId && detail.data.activeJobId !== jobId ? detail.data.activeJobId : null;

  const rowParams = useMemo(() => filtersToParams(filters), [filters]);
  const rows = rowsQuery.data?.rows ?? [];

  if (detail.isLoading || !manifest || !stats) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (detail.isError) {
    return (
      <div className="mx-auto max-w-6xl p-6">
        <Alert variant="destructive">
          <AlertTitle>Could not load this batch</AlertTitle>
          <AlertDescription>{(detail.error as Error).message}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/" aria-label="Back to batches">
              <ArrowLeft />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold">{manifest.name}</h1>
              <JobStateBadge state={state} />
            </div>
            <p className="tabular text-xs text-muted-foreground">{jobId}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <ControlBar jobId={jobId} state={state} stats={stats} blockedBy={blockedBy} onError={setBanner} />
          {!isRunning && (
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-status-failed"
              onClick={async () => {
                if (!confirm('Delete this batch and everything it wrote?')) return;
                await api.deleteJob(jobId).catch(() => undefined);
                router.push('/');
              }}
              aria-label="Delete batch"
            >
              <Trash2 />
            </Button>
          )}
        </div>
      </div>

      {banner && (
        <Alert variant="destructive">
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>{banner}</AlertDescription>
        </Alert>
      )}

      {state === 'interrupted' && (
        <Alert variant="warning">
          <AlertTitle>This batch was interrupted</AlertTitle>
          <AlertDescription>
            The server stopped mid-run. All {stats.completed} completed products are saved — press
            Resume to scrape the remaining {stats.pending}.
          </AlertDescription>
        </Alert>
      )}

      <StatGrid stats={stats} />

      <LiveProgressPanel progress={stream.progress} stats={stats} isRunning={isRunning} />

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">Queue</TabsTrigger>
          <TabsTrigger value="failed">
            Failed{stats.failed > 0 ? ` (${stats.failed})` : ''}
          </TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="space-y-3">
          <FilterBar
            filters={filters}
            onChange={setFilters}
            matched={rowsQuery.data?.matched ?? rows.length}
            total={rowsQuery.data?.total ?? stats.total}
            actions={
              <ExportButtons jobId={jobId} params={rowParams} matched={rowsQuery.data?.matched ?? rows.length} />
            }
          />
          <QueueTable rows={rows} />
          {(rowsQuery.data?.matched ?? 0) > rows.length && (
            <p className="text-center text-xs text-muted-foreground">
              Showing the first {rows.length} of {rowsQuery.data?.matched}. Narrow the filters or export
              to see everything.
            </p>
          )}
        </TabsContent>

        <TabsContent value="failed">
          <FailedProducts jobId={jobId} canRetry={!isRunning} />
        </TabsContent>

        <TabsContent value="logs">
          <LogViewer jobId={jobId} liveLogs={stream.logs} />
        </TabsContent>

        <TabsContent value="analytics">
          <AnalyticsCharts jobId={jobId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
