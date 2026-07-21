/**
 * Analytics, computed from the in-memory row index.
 *
 * All of it is derived on demand rather than maintained incrementally: a batch
 * is at most a few thousand rows, and a stale counter would be far worse than a
 * millisecond of arithmetic.
 */

import type { JobRow } from '@/types/dashboard';
import type { AnalyticsPayload } from '@/lib/api';

/** Duration buckets, in ms. A scrape that takes a minute means something different from one that takes three seconds. */
const DURATION_BUCKETS: { label: string; max: number }[] = [
  { label: '<2s', max: 2_000 },
  { label: '2–5s', max: 5_000 },
  { label: '5–10s', max: 10_000 },
  { label: '10–20s', max: 20_000 },
  { label: '20–60s', max: 60_000 },
  { label: '>60s', max: Infinity },
];

export function computeAnalytics(rows: JobRow[]): AnalyticsPayload {
  const finished = rows.filter((row) => row.result);
  const succeeded = finished.filter((row) => row.result?.status === 'OK');
  const failed = finished.filter((row) => row.result?.status !== 'OK');

  return {
    outcome: [
      { name: 'Succeeded', value: succeeded.length },
      { name: 'Failed', value: failed.length },
      { name: 'Pending', value: rows.length - finished.length },
    ],
    failureReasons: countBy(failed, (row) => row.result?.status ?? 'ERROR')
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    sellers: sellerBreakdown(rows),
    perHour: perHour(finished),
    durations: durationHistogram(finished),
    averageMs: average(finished.map((row) => row.durationMs)),
    medianMs: median(finished.map((row) => row.durationMs)),
  };
}

function sellerBreakdown(rows: JobRow[]): AnalyticsPayload['sellers'] {
  const map = new Map<string, { total: number; succeeded: number; failed: number }>();

  for (const row of rows) {
    const key = row.targetSeller || '(none)';
    const entry = map.get(key) ?? { total: 0, succeeded: 0, failed: 0 };
    entry.total++;
    if (row.result) {
      if (row.result.status === 'OK') entry.succeeded++;
      else entry.failed++;
    }
    map.set(key, entry);
  }

  return [...map.entries()]
    .map(([seller, counts]) => ({ seller, ...counts }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 20);
}

/**
 * Throughput by clock hour.
 *
 * Bucketed on the completion timestamp the dashboard stamps, which is why this
 * only covers rows scraped through the dashboard — a journal produced by the
 * CLI has no timestamps and simply contributes nothing here.
 */
function perHour(rows: JobRow[]): AnalyticsPayload['perHour'] {
  const map = new Map<string, { completed: number; succeeded: number; failed: number }>();

  for (const row of rows) {
    if (!row.finishedAt) continue;
    const date = new Date(row.finishedAt);
    if (Number.isNaN(date.getTime())) continue;

    const hour = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:00`;
    const entry = map.get(hour) ?? { completed: 0, succeeded: 0, failed: 0 };
    entry.completed++;
    if (row.result?.status === 'OK') entry.succeeded++;
    else entry.failed++;
    map.set(hour, entry);
  }

  return [...map.entries()]
    .map(([hour, counts]) => ({ hour, ...counts }))
    .sort((a, b) => a.hour.localeCompare(b.hour));
}

function durationHistogram(rows: JobRow[]): AnalyticsPayload['durations'] {
  const counts = DURATION_BUCKETS.map((bucket) => ({ bucket: bucket.label, count: 0 }));

  for (const row of rows) {
    const duration = row.durationMs;
    if (duration === undefined) continue;
    const index = DURATION_BUCKETS.findIndex((bucket) => duration < bucket.max);
    counts[index === -1 ? counts.length - 1 : index].count++;
  }

  return counts;
}

function countBy<T>(items: T[], key: (item: T) => string): [string, number][] {
  const map = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()];
}

function average(values: (number | undefined)[]): number | null {
  const numbers = values.filter((value): value is number => typeof value === 'number');
  if (!numbers.length) return null;
  return Math.round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
}

function median(values: (number | undefined)[]): number | null {
  const numbers = values.filter((value): value is number => typeof value === 'number').sort((a, b) => a - b);
  if (!numbers.length) return null;

  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2
    ? numbers[middle]
    : Math.round((numbers[middle - 1] + numbers[middle]) / 2);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
