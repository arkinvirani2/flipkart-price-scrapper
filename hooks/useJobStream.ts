'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { JobEvent, JobRow, JobState, JobStats, LiveProgress, LogEntry } from '@/types/dashboard';

export interface JobStream {
  connected: boolean;
  state: JobState | null;
  stats: JobStats | null;
  progress: LiveProgress | null;
  /** Rows that have landed since this stream opened, newest first. */
  recentRows: JobRow[];
  logs: LogEntry[];
}

/** Cap on resident log lines. A multi-hour run would otherwise grow without bound. */
const MAX_LOGS = 1_000;
const MAX_RECENT_ROWS = 50;

/**
 * Subscribe to a job's SSE stream.
 *
 * The stream is the source of live truth: React Query fetches the initial
 * snapshot, and every subsequent change arrives here as a single small event
 * rather than by refetching the whole table. Row updates also patch the cached
 * rows query in place, so the queue stays current without a network round-trip
 * per product.
 */
export function useJobStream(jobId: string | null): JobStream {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<JobState | null>(null);
  const [stats, setStats] = useState<JobStats | null>(null);
  const [progress, setProgress] = useState<LiveProgress | null>(null);
  const [recentRows, setRecentRows] = useState<JobRow[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!jobId) return;

    setRecentRows([]);
    setLogs([]);

    const source = new EventSource(`/api/jobs/${jobId}/events`);
    sourceRef.current = source;

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    source.onmessage = (message) => {
      let event: JobEvent;
      try {
        event = JSON.parse(message.data) as JobEvent;
      } catch {
        return;
      }

      switch (event.type) {
        case 'state':
          setState(event.state);
          setStats(event.stats);
          // The manifest changed shape (timestamps, state); let the detail query refetch.
          queryClient.invalidateQueries({ queryKey: ['job', jobId] });
          queryClient.invalidateQueries({ queryKey: ['jobs'] });
          break;

        case 'progress':
          setProgress(event.progress);
          break;

        case 'row':
          setStats(event.stats);
          setRecentRows((previous) => [event.row, ...previous].slice(0, MAX_RECENT_ROWS));
          patchRowCaches(queryClient, jobId, event.row);
          break;

        case 'log':
          setLogs((previous) => {
            const next = [...previous, event.entry];
            return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
          });
          break;

        case 'heartbeat':
          break;
      }
    };

    return () => {
      source.close();
      sourceRef.current = null;
      setConnected(false);
    };
  }, [jobId, queryClient]);

  return { connected, state, stats, progress, recentRows, logs };
}

/**
 * Splice an updated row into every cached rows query for this job.
 *
 * Patching beats invalidating: a 1000-row batch finishing a product every few
 * seconds would otherwise refetch the entire table on every completion.
 */
function patchRowCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  jobId: string,
  row: JobRow,
): void {
  queryClient.setQueriesData<{ rows: JobRow[]; total: number; matched: number }>(
    { queryKey: ['rows', jobId] },
    (previous) => {
      if (!previous) return previous;
      const index = previous.rows.findIndex((candidate) => candidate.index === row.index);
      if (index === -1) return previous;

      const rows = [...previous.rows];
      rows[index] = row;
      return { ...previous, rows };
    },
  );
}
