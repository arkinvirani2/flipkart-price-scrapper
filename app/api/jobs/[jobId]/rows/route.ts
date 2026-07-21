/**
 * GET /api/jobs/:jobId/rows — the queue, filtered and paginated.
 *
 * Filtering runs server-side against the in-memory index, so a 1000-row batch
 * never ships 1000 rows to the browser to be filtered there.
 */

import { NextResponse } from 'next/server';
import { getRows } from '@/lib/store/jobStore';
import { filterRows, parseRowFilters } from '@/lib/services/rowFilters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { jobId } = await params;
  const url = new URL(request.url);

  // An empty list is legitimate for a job that has not started, so no 404 here.
  const rows = getRows(jobId);
  const filters = parseRowFilters(url.searchParams);
  const matched = filterRows(rows, filters);

  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
  const limit = Math.min(5_000, Math.max(1, Number(url.searchParams.get('limit') ?? 500) || 500));

  return NextResponse.json({
    rows: matched.slice(offset, offset + limit),
    total: rows.length,
    matched: matched.length,
    offset,
    limit,
  });
}
