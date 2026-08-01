/**
 * GET    /api/jobs/:jobId — manifest, stats and current progress.
 * DELETE /api/jobs/:jobId — remove a batch and everything it wrote.
 */

import { NextResponse } from 'next/server';
import { computeStats, deleteJob, getJob } from '@/lib/store/jobStore';
import { getRunner } from '@/lib/runner/jobRunner';
import { ensureRecovered } from '@/lib/services/recovery';
import { resetAccount } from '@/lib/intelligence/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ jobId: string }> };

export async function GET(_request: Request, { params }: Context) {
  ensureRecovered();
  const { jobId } = await params;

  const record = getJob(jobId);
  if (!record) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });

  const runner = getRunner();
  return NextResponse.json({
    job: record.manifest,
    stats: computeStats(jobId),
    progress: runner.isActive(jobId) ? runner.progress() : null,
    isActive: runner.isActive(jobId),
    activeJobId: runner.activeJobId(),
  });
}

export async function DELETE(_request: Request, { params }: Context) {
  const { jobId } = await params;

  if (getRunner().isActive(jobId)) {
    return NextResponse.json({ error: 'Stop the job before deleting it.' }, { status: 409 });
  }

  // Note the account before the folder goes: the learned metrics are running
  // sums over this job's outcomes and there is no way to subtract one job back
  // out of them. Dropping the account's intelligence makes the next run replay
  // the surviving uploads from scratch, which is the only correct answer.
  const accountName = getJob(jobId)?.manifest.accountName;

  if (!deleteJob(jobId)) {
    return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
  }

  if (accountName) resetAccount(accountName);
  return NextResponse.json({ deleted: true });
}
