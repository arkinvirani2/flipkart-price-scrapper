/**
 * GET  /api/jobs — every batch, newest first, with live counts.
 * POST /api/jobs — create a batch from validated rows.
 */

import { NextResponse } from 'next/server';
import { computeStats, createJob, listJobs } from '@/lib/store/jobStore';
import { ensureRecovered } from '@/lib/services/recovery';
import { getRunner } from '@/lib/runner/jobRunner';
import { validateUpload } from '@/lib/validation/uploadSchema';
import { DEFAULT_JOB_OPTIONS, type JobOptions } from '@/types/dashboard';
import type { OrdersReport } from '@/lib/demand';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  // Any entry point may be the first one hit after a restart, so recovery runs
  // here rather than in a bootstrap file that a given request might not import.
  ensureRecovered();

  const jobs = listJobs().map((manifest) => ({ ...manifest, stats: computeStats(manifest.id) }));
  return NextResponse.json({ jobs, activeJobId: getRunner().activeJobId() });
}

export async function POST(request: Request) {
  ensureRecovered();

  let body: {
    name?: string;
    accountName?: string;
    rows?: unknown;
    options?: Partial<JobOptions>;
    orders?: OrdersReport | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  // Re-validate server-side. The client already did, but the client is not the
  // authority on what lands on disk.
  const report = validateUpload(JSON.stringify(body.rows ?? []));
  if (!report.ok) {
    return NextResponse.json({ error: 'Rows failed validation.', report }, { status: 400 });
  }

  const options: JobOptions = { ...DEFAULT_JOB_OPTIONS, ...(body.options ?? {}) };
  const name = (body.name ?? '').trim() || `Batch of ${report.rows.length}`;
  // The account defaults to the seller name the rows already carry, so a client
  // that does not send one still lands in the right history.
  const accountName = (body.accountName ?? '').trim() || report.rows[0]?.targetSeller || '';
  const manifest = createJob(name, report.rows, options, accountName, ordersOrNull(body.orders));

  return NextResponse.json({ job: manifest, stats: computeStats(manifest.id) }, { status: 201 });
}

/**
 * Accept an orders report only if it still looks like one.
 *
 * The client posts back what /api/upload parsed, so this is a round-trip check
 * rather than a re-parse: anything without a window and an FSN index is dropped
 * to null, because a malformed report reads downstream as universal zero demand.
 */
function ordersOrNull(orders: OrdersReport | null | undefined): OrdersReport | null {
  if (!orders || typeof orders !== 'object') return null;
  if (typeof orders.windowEnd !== 'string' || typeof orders.observedDays !== 'number') return null;
  if (!orders.byFsn || typeof orders.byFsn !== 'object') return null;
  return orders;
}
