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

  let body: { name?: string; accountName?: string; rows?: unknown; options?: Partial<JobOptions> };
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
  const manifest = createJob(name, report.rows, options, accountName);

  return NextResponse.json({ job: manifest, stats: computeStats(manifest.id) }, { status: 201 });
}
