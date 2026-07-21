/** GET /api/jobs/:jobId/analytics — chart data for one batch. */

import { NextResponse } from 'next/server';
import { computeAnalytics } from '@/lib/services/analytics';
import { getJob, getRows } from '@/lib/store/jobStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ jobId: string }> };

export async function GET(_request: Request, { params }: Context) {
  const { jobId } = await params;
  if (!getJob(jobId)) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });

  return NextResponse.json(computeAnalytics(getRows(jobId)));
}
