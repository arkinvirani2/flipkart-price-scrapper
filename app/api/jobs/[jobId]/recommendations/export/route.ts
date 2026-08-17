/**
 * GET /api/jobs/:jobId/recommendations/export?format=csv|xlsx
 *
 * Exports the Price Change list and nothing else — the other three tabs are
 * outcomes, not work. An optional `search` narrows it to what the user had on
 * screen, so the file matches the table it was downloaded from.
 */

import { NextResponse } from 'next/server';
import {
  exportFilename,
  recommendationCsvStream,
  recommendationXlsxBuffer,
} from '@/lib/services/exportService';
import { ensureRecommendations } from '@/lib/services/recommendations';
import { getJob } from '@/lib/store/jobStore';
import type { Recommendation } from '@/lib/recommendation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ jobId: string }> };

function matchesSearch(item: Recommendation, needle: string): boolean {
  return [item.sku, item.fsn, item.winningSeller, item.reason, item.accountName, item.reasonCode]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

export async function GET(request: Request, { params }: Context) {
  const { jobId } = await params;
  const record = getJob(jobId);
  if (!record) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });

  const file = ensureRecommendations(jobId);
  if (!file) return NextResponse.json({ error: 'No recommendations for this job.' }, { status: 404 });

  const url = new URL(request.url);
  const format = (url.searchParams.get('format') ?? 'xlsx').toLowerCase();
  const search = url.searchParams.get('search')?.trim().toLowerCase();

  let rows = file.recommendations.filter((item) => item.category === 'priceChange');
  if (search) rows = rows.filter((item) => matchesSearch(item, search));

  if (format === 'csv') {
    return new Response(recommendationCsvStream(rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFilename(record.manifest, 'csv', 'price-change')}"`,
      },
    });
  }

  if (format === 'xlsx') {
    const buffer = await recommendationXlsxBuffer(record.manifest, rows, {
      accountName: file.accountName,
      uploadTime: file.uploadTime,
      generatedAt: file.generatedAt,
      summary: file.summary,
    });

    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${exportFilename(record.manifest, 'xlsx', 'price-change')}"`,
        'Content-Length': String(buffer.length),
      },
    });
  }

  return NextResponse.json({ error: 'format must be csv or xlsx.' }, { status: 400 });
}
