'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Inbox, Loader2, Trash2, Upload } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { JobStateBadge } from '@/components/dashboard/StatusBadge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import type { JobSummary } from '@/lib/api';
import { formatDateTime, formatDuration, formatPercent } from '@/lib/format';

export default function BatchesPage() {
  const queryClient = useQueryClient();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['jobs'],
    queryFn: api.listJobs,
    // Cheap poll so a batch started in another tab shows up. The heavy live
    // updates come over SSE on the job page, not from here.
    refetchInterval: 5_000,
  });

  const jobs = data?.jobs ?? [];
  const interrupted = jobs.filter((job) => job.state === 'interrupted');
  const groupedJobs = useMemo(() => groupJobsByDate(jobs), [jobs]);

  const deleteBatch = useMutation({
    mutationFn: api.deleteJob,
    onMutate: () => setDeleteError(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
    onError: (mutationError) => setDeleteError((mutationError as Error).message),
  });

  return (
    <div className="w-full space-y-6 p-4 xl:p-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Batches</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {jobs.length} batch{jobs.length === 1 ? '' : 'es'}
            {data?.activeJobId ? ' — one running now' : ''}
          </p>
        </div>
        <Button asChild>
          <Link href="/upload">
            <Upload /> New batch
          </Link>
        </Button>
      </header>

      {interrupted.length > 0 && (
        <Alert variant="warning" className="animate-banner">
          <AlertTriangle />
          <AlertTitle>
            {interrupted.length} batch{interrupted.length === 1 ? '' : 'es'} did not finish
          </AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              The server stopped while these were running. Every completed product was saved — resume
              to pick up exactly where it left off.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              {interrupted.map((job) => (
                <Button key={job.id} size="sm" variant="outline" asChild>
                  <Link href={`/jobs/${job.id}`}>
                    Resume {job.name} ({job.stats.pending} left) <ArrowRight />
                  </Link>
                </Button>
              ))}
            </div>
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Could not load batches</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      )}

      {deleteError && (
        <Alert variant="destructive">
          <AlertTitle>Could not delete batch</AlertTitle>
          <AlertDescription>{deleteError}</AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-24 w-full" />
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-12 text-center">
          <Inbox className="size-8 text-muted-foreground" aria-hidden />
          <div>
            <p className="font-medium">No batches yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Upload a seller listing spreadsheet to get started.
            </p>
          </div>
          <Button asChild className="mt-2">
            <Link href="/upload">
              <Upload /> Upload a file
            </Link>
          </Button>
        </Card>
      ) : (
        <div className="space-y-6">
          {groupedJobs.map((group) => (
            <section key={group.key} className="space-y-3">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-semibold">{group.label}</h2>
                <span className="h-px flex-1 bg-border" />
                <span className="text-xs text-muted-foreground">
                  {group.jobs.length} batch{group.jobs.length === 1 ? '' : 'es'}
                </span>
              </div>

              <div className="space-y-3">
                {group.jobs.map((job) => (
                  <BatchRow
                    key={job.id}
                    job={job}
                    live={job.id === data?.activeJobId}
                    deleting={deleteBatch.isPending && deleteBatch.variables === job.id}
                    onDelete={() => {
                      if (!confirm(`Delete batch "${job.name}" and everything it wrote?`)) return;
                      deleteBatch.mutate(job.id);
                    }}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function BatchRow({
  job,
  live,
  deleting,
  onDelete,
}: {
  job: JobSummary;
  live: boolean;
  deleting: boolean;
  onDelete: () => void;
}) {
  const done = job.stats.completed;
  const percent = job.stats.total ? (done / job.stats.total) * 100 : 0;

  return (
    <Card className="flex overflow-hidden transition-colors hover:border-primary/40 hover:bg-accent/30">
      <Link href={`/jobs/${job.id}`} className="min-w-0 flex-1 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate font-medium">{job.name}</h3>
              <JobStateBadge state={job.state} />
              {live && <Loader2 className="size-3.5 animate-spin text-status-running" />}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Created {formatDateTime(job.createdAt)}</p>
          </div>

          <dl className="flex shrink-0 gap-6 text-sm">
            <Stat label="Products" value={job.stats.total} />
            <Stat label="Done" value={done} className="text-status-success" />
            <Stat label="Failed" value={job.stats.failed} className="text-status-failed" />
            <Stat label="Success" value={formatPercent(job.stats.successRate)} />
            <Stat label="Avg" value={formatDuration(job.stats.averageMs)} />
          </dl>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <Progress
            value={percent}
            className="h-1.5"
            indicatorClassName={job.stats.failed > 0 ? 'bg-status-paused' : 'bg-status-success'}
          />
          <span className="tabular shrink-0 text-xs text-muted-foreground">
            {done}/{job.stats.total}
          </span>
        </div>
      </Link>

      <div className="flex items-start border-l p-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-status-failed"
          onClick={onDelete}
          disabled={live || deleting}
          aria-label={live ? 'Cannot delete a running batch' : `Delete ${job.name}`}
          title={live ? 'Stop the running batch before deleting it' : 'Delete batch'}
        >
          {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
        </Button>
      </div>
    </Card>
  );
}

function Stat({ label, value, className }: { label: string; value: string | number; className?: string }) {
  return (
    <div className="text-right">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={`tabular font-medium ${className ?? ''}`}>{value}</dd>
    </div>
  );
}

function groupJobsByDate(jobs: JobSummary[]): { key: string; label: string; jobs: JobSummary[] }[] {
  const sorted = [...jobs].sort((left, right) => {
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });
  const groups = new Map<string, { key: string; label: string; jobs: JobSummary[] }>();

  for (const job of sorted) {
    const date = new Date(job.createdAt);
    const validDate = Number.isNaN(date.getTime()) ? new Date(0) : date;
    const key = validDate.toISOString().slice(0, 10);
    const existing = groups.get(key);

    if (existing) {
      existing.jobs.push(job);
      continue;
    }

    groups.set(key, {
      key,
      label: validDate.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }),
      jobs: [job],
    });
  }

  return Array.from(groups.values());
}
