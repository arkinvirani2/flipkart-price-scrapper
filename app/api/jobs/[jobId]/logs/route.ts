/**
 * GET /api/jobs/:jobId/logs — the log history, filterable.
 *
 * `?download=1` streams the raw NDJSON file instead, so the download is the
 * complete record rather than whatever the viewer happened to be showing.
 */

import { createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { getJob } from '@/lib/store/jobStore';
import { logFilePath, readAllLogs } from '@/lib/store/logStore';
import type { LogLevel } from '@/types/dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { jobId } = await params;
  const record = getJob(jobId);
  if (!record) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });

  const url = new URL(request.url);

  if (url.searchParams.get('download') === '1') {
    const path = logFilePath(jobId);
    if (!existsSync(path)) {
      return NextResponse.json({ error: 'No logs yet.' }, { status: 404 });
    }

    const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
    const safeName = record.manifest.name.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || jobId;

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeName}-logs.ndjson"`,
      },
    });
  }

  const levels = url.searchParams.getAll('level').flatMap((value) => value.split(',')).filter(Boolean) as LogLevel[];
  const search = url.searchParams.get('search')?.trim().toLowerCase();
  const limit = Math.min(20_000, Math.max(1, Number(url.searchParams.get('limit') ?? 2_000) || 2_000));

  let entries = await readAllLogs(jobId);

  if (levels.length) entries = entries.filter((entry) => levels.includes(entry.level));
  if (search) {
    entries = entries.filter((entry) =>
      [entry.message, entry.sku, entry.fsn, entry.seller]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(search),
    );
  }

  const total = entries.length;
  // The tail is what a viewer wants: the newest lines, not the oldest.
  return NextResponse.json({ entries: entries.slice(-limit), total });
}
