'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Inbox, Loader2, Upload } from 'lucide-react';
import Link from 'next/link';
import { JobStateBadge } from '@/components/dashboard/StatusBadge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatDateTime, formatDuration, formatPercent } from '@/lib/format';

export default function BatchesPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['jobs'],
    queryFn: api.listJobs,
    // Cheap poll so a batch started in another tab shows up. The heavy live
    // updates come over SSE on the job page, not from here.
    refetchInterval: 5_000,
  });

  const jobs = data?.jobs ?? [];
  const interrupted = jobs.filter((job) => job.state === 'interrupted');

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
              Upload a JSON file of products to get started.
            </p>
          </div>
          <Button asChild className="mt-2">
            <Link href="/upload">
              <Upload /> Upload a file
            </Link>
          </Button>
        </Card>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => {
            const done = job.stats.completed;
            const percent = job.stats.total ? (done / job.stats.total) * 100 : 0;
            const live = job.id === data?.activeJobId;

            return (
              <Link key={job.id} href={`/jobs/${job.id}`} className="block">
                <Card className="p-4 transition-colors hover:border-primary/40 hover:bg-accent/30">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h2 className="truncate font-medium">{job.name}</h2>
                        <JobStateBadge state={job.state} />
                        {live && <Loader2 className="size-3.5 animate-spin text-status-running" />}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Created {formatDateTime(job.createdAt)}
                      </p>
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
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
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
