'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, Download, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { LogEntry, LogLevel } from '@/types/dashboard';

const LEVELS: LogLevel[] = ['step', 'info', 'warn', 'error'];

const LEVEL_STYLES: Record<LogLevel, string> = {
  step: 'text-status-running',
  info: 'text-muted-foreground',
  warn: 'text-status-paused',
  error: 'text-status-failed',
};

interface Props {
  jobId: string;
  /** Lines arriving over SSE since the page opened. */
  liveLogs: LogEntry[];
}

export function LogViewer({ jobId, liveLogs }: Props) {
  const [search, setSearch] = useState('');
  const [levels, setLevels] = useState<LogLevel[]>([]);
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const history = useQuery({
    queryKey: ['logs', jobId],
    queryFn: () => api.logs(jobId),
  });

  // History comes from the file, live lines from the stream. Merging by id and
  // sorting keeps them in order without double-counting the overlap.
  const entries = useMemo(() => {
    const byId = new Map<number, LogEntry>();
    for (const entry of history.data?.entries ?? []) byId.set(entry.id, entry);
    for (const entry of liveLogs) byId.set(entry.id, entry);
    return [...byId.values()].sort((a, b) => a.id - b.id);
  }, [history.data, liveLogs]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return entries.filter((entry) => {
      if (levels.length && !levels.includes(entry.level)) return false;
      if (!needle) return true;
      return [entry.message, entry.sku, entry.fsn, entry.seller]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [entries, levels, search]);

  useEffect(() => {
    if (!follow || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [filtered.length, follow]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search log messages, SKU or seller…"
            className="pl-8"
          />
        </div>

        <div className="flex gap-1.5">
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              onClick={() =>
                setLevels((current) =>
                  current.includes(level) ? current.filter((l) => l !== level) : [...current, level],
                )
              }
              className={cn(
                'rounded-md border px-2 py-1 text-xs uppercase transition-colors',
                levels.includes(level)
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {level}
            </button>
          ))}
        </div>

        <Button
          variant={follow ? 'default' : 'outline'}
          size="sm"
          onClick={() => setFollow((value) => !value)}
        >
          <ArrowDownToLine /> {follow ? 'Following' : 'Follow'}
        </Button>

        <Button variant="outline" size="sm" asChild>
          <a href={`/api/jobs/${jobId}/logs?download=1`} download>
            <Download /> Download
          </a>
        </Button>
      </div>

      <div
        ref={scrollRef}
        onScroll={(event) => {
          // Scrolling up is an explicit "let me read" — stop yanking them back down.
          const element = event.currentTarget;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
          if (!atBottom && follow) setFollow(false);
        }}
        className="h-[28rem] overflow-auto scrollbar-thin rounded-lg border bg-muted/20 p-2 font-mono text-xs"
      >
        {history.isLoading ? (
          <p className="p-4 text-center text-muted-foreground">Loading logs…</p>
        ) : filtered.length === 0 ? (
          <p className="p-4 text-center text-muted-foreground">
            {entries.length === 0 ? 'No log lines yet.' : 'Nothing matches those filters.'}
          </p>
        ) : (
          filtered.map((entry) => (
            <div
              key={entry.id}
              className="grid grid-cols-[6rem_3.5rem_8rem_1fr_5rem] gap-2 border-b border-border/40 px-1 py-1 last:border-0"
            >
              <span className="tabular text-muted-foreground">{timeOf(entry.ts)}</span>
              <span className={cn('uppercase', LEVEL_STYLES[entry.level])}>{entry.level}</span>
              <span className="truncate text-muted-foreground" title={entry.sku ?? ''}>
                {entry.sku ?? '—'}
              </span>
              <span className="whitespace-pre-wrap break-words">{entry.message}</span>
              <span className="tabular text-right text-muted-foreground">
                {entry.durationMs ? formatDuration(entry.durationMs) : ''}
              </span>
            </div>
          ))
        )}
      </div>

      <p className="tabular text-xs text-muted-foreground">
        {filtered.length} of {entries.length} lines
        {history.data && history.data.total > entries.length
          ? ` — file holds ${history.data.total}`
          : ''}
      </p>
    </div>
  );
}

function timeOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-IN', { hour12: false });
}
