/**
 * GET /api/jobs/:jobId/export?format=csv|xlsx
 *
 * Accepts the same filter params as the rows endpoint, so "export" means
 * exactly what the user can see on screen rather than silently something else.
 */

import { NextResponse } from 'next/server';
import { csvStream, exportFilename, xlsxBuffer } from '@/lib/services/exportService';
import { filterRows, parseRowFilters } from '@/lib/services/rowFilters';
import { getJob, getRows } from '@/lib/store/jobStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { jobId } = await params;
  const record = getJob(jobId);
  if (!record) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });

  const url = new URL(request.url);
  const format = (url.searchParams.get('format') ?? 'csv').toLowerCase();
  const rows = filterRows(getRows(jobId), parseRowFilters(url.searchParams));

  if (format === 'csv') {
    return new Response(csvStream(rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFilename(record.manifest, 'csv')}"`,
      },
    });
  }

  if (format === 'xlsx') {
    const buffer = await xlsxBuffer(record.manifest, rows);
    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${exportFilename(record.manifest, 'xlsx')}"`,
        'Content-Length': String(buffer.length),
      },
    });
  }

  return NextResponse.json({ error: 'format must be csv or xlsx.' }, { status: 400 });
}
