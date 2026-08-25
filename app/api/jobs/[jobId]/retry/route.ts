/**
 * POST /api/jobs/:jobId/retry — { indexes: number[] }
 *
 * Drops those rows' journal entries so they count as pending again. It does not
 * start a run; the user decides when to resume, which keeps retry from quietly
 * seizing the single runner slot.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { computeStats, getJob, requeueRows, setJobState } from '@/lib/store/jobStore';
import { getRunner } from '@/lib/runner/jobRunner';
import { appendLog } from '@/lib/store/logStore';
import { publish } from '@/lib/runner/eventBus';
import { ACTIVE_STATES, RESUMABLE_STATES, type JobState } from '@/types/dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  indexes: z.array(z.number().int().nonnegative()).min(1).max(10_000),
});

type Context = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, { params }: Context) {
  const { jobId } = await params;

  if (!getJob(jobId)) {
    return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
  }

  // Rewriting the journal underneath a live run would race the appends it is
  // making, so retry is only allowed while the job is idle.
  if (getRunner().isActive(jobId)) {
    return NextResponse.json(
      { error: 'Pause or stop the batch before requeuing rows.' },
      { status: 409 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'indexes must be a non-empty array of row numbers.' }, { status: 400 });
  }

  const requeued = requeueRows(jobId, parsed.data.indexes);
  let state: JobState = getJob(jobId)?.manifest.state ?? 'queued';

  if (requeued > 0) {
    // A finished batch has work again, so it cannot stay in a terminal state:
    // the dashboard only offers Start/Resume from a resumable one, and would
    // otherwise leave the user with rows to scrape and no way to scrape them.
    // 'stopped' is the honest description — unfinished work, runner not ours.
    if (!RESUMABLE_STATES.includes(state) && !ACTIVE_STATES.includes(state)) {
      setJobState(jobId, 'stopped', { finishedAt: undefined });
      state = 'stopped';
    }
  }

  const stats = computeStats(jobId);

  if (requeued > 0) {
    const entry = appendLog(jobId, 'info', `${requeued} product(s) requeued for another attempt.`);
    publish(jobId, { type: 'log', entry });
    // The stream is what the dashboard trusts for state and stats once it is
    // connected, so a requeue that only rewrote the journal would leave every
    // open tab showing a completed batch with nothing pending.
    publish(jobId, { type: 'state', jobId, state, stats });
  }

  return NextResponse.json({ requeued, state, stats });
}
