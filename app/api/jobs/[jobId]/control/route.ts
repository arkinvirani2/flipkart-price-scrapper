/**
 * POST /api/jobs/:jobId/control — { action: 'start' | 'pause' | 'resume' | 'stop' }
 *
 * Start and resume are the same call. That is not a shortcut: resuming *is*
 * starting a run over whatever the journal says is still pending, so giving
 * them separate code paths would mean two implementations of the resume rule.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { computeStats, getJob } from '@/lib/store/jobStore';
import { getRunner } from '@/lib/runner/jobRunner';
import { ensureRecovered } from '@/lib/services/recovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  action: z.enum(['start', 'resume', 'pause', 'stop']),
});

type Context = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, { params }: Context) {
  ensureRecovered();
  const { jobId } = await params;

  if (!getJob(jobId)) {
    return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
  }

  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(parsedBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'action must be one of: start, resume, pause, stop.' },
      { status: 400 },
    );
  }

  const runner = getRunner();
  const { action } = parsed.data;

  if (action === 'start' || action === 'resume') {
    const result = runner.start(jobId);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
    return NextResponse.json({ ok: true, pending: result.pending, stats: computeStats(jobId) });
  }

  const result = action === 'pause' ? runner.pause(jobId) : runner.stop(jobId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });

  return NextResponse.json({ ok: true, stats: computeStats(jobId) });
}
