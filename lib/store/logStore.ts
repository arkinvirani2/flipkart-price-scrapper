/**
 * Per-job log storage: NDJSON on disk, ring buffer in memory.
 *
 * A long batch produces tens of thousands of lines. The file keeps all of them
 * for download; memory keeps only the tail, which is what a viewer can actually
 * render. Reading the full history is a file read, not a memory cost.
 */

import { appendFileSync, createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { LogEntry, LogLevel } from '@/types/dashboard';
import { ensureJobDir, jobPaths } from './paths';

/** How many lines stay resident per job. Enough to fill any viewport many times over. */
const RING_SIZE = 2_000;

interface LogState {
  buffers: Map<string, LogEntry[]>;
  nextId: number;
}

const state: LogState = ((globalThis as Record<string, unknown>).__logState as LogState) ?? {
  buffers: new Map<string, LogEntry[]>(),
  nextId: 1,
};
(globalThis as Record<string, unknown>).__logState = state;

export interface LogContext {
  sku?: string;
  fsn?: string;
  seller?: string;
  rowIndex?: number;
  durationMs?: number;
}

/** Append a line to a job's log. Returns the stored entry, ready to broadcast. */
export function appendLog(
  jobId: string,
  level: LogLevel,
  message: string,
  context: LogContext = {},
): LogEntry {
  const entry: LogEntry = {
    id: state.nextId++,
    ts: new Date().toISOString(),
    jobId,
    level,
    message: message.trim(),
    ...context,
  };

  const ring = state.buffers.get(jobId) ?? [];
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  state.buffers.set(jobId, ring);

  try {
    ensureJobDir(jobId);
    appendFileSync(jobPaths.logs(jobId), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Losing a log line must never abort a scrape.
  }

  return entry;
}

/** The resident tail, for an initial page load. */
export function recentLogs(jobId: string, limit = 500): LogEntry[] {
  const ring = state.buffers.get(jobId);
  if (ring?.length) return ring.slice(-limit);
  return [];
}

/**
 * Stream the full log from disk.
 *
 * Line-by-line rather than readFileSync: a multi-hour batch can produce a log
 * far larger than anything worth holding in memory at once.
 */
export async function readAllLogs(jobId: string, limit = 50_000): Promise<LogEntry[]> {
  const path = jobPaths.logs(jobId);
  if (!existsSync(path)) return [];

  const entries: LogEntry[] = [];
  const reader = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });

  for await (const line of reader) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      // Same tolerance as the result journal: a torn final line is expected.
    }
    if (entries.length >= limit) break;
  }

  reader.close();
  return entries;
}

/** Path to the raw NDJSON, for the download endpoint. */
export function logFilePath(jobId: string): string {
  return jobPaths.logs(jobId);
}

export function clearLogBuffer(jobId: string): void {
  state.buffers.delete(jobId);
}

/**
 * Drop every resident log line, for a full reset.
 *
 * The ring buffers are keyed by job id and nothing prunes them when a job's
 * directory is deleted, so a reset that only removed files would leave the last
 * two thousand lines of every wiped batch answering `recentLogs` until the
 * server restarted. `nextId` restarts too: the ids are only ever used to order
 * and de-duplicate lines within a viewer session, and a fresh start should read
 * from one.
 */
export function clearAllLogs(): void {
  state.buffers.clear();
  state.nextId = 1;
}
