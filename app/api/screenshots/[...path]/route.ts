
/**
 * GET /api/screenshots/<jobId>/<file>.png — serve a failure screenshot.
 *
 * Screenshot paths originate in the journal, which is a file on disk that could
 * in principle be edited. So the path is re-derived from the URL segments and
 * confined to the data directory rather than trusted: without that, a crafted
 * path would turn this route into arbitrary file read.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { jobPaths, resolveWithinData } from '@/lib/store/paths';

export const runtime = 'nodejs';

type Context = { params: Promise<{ path: string[] }> };

export async function GET(_request: Request, { params }: Context) {
  const { path: segments } = await params;

  if (!segments?.length || segments.length !== 2) {
    return NextResponse.json({ error: 'Expected /api/screenshots/<jobId>/<file>.' }, { status: 400 });
  }

  const [jobId, filename] = segments;

  // No separators, no traversal, images only.
  if (!/^[A-Za-z0-9_.-]+\.png$/.test(filename) || filename.includes('..')) {
    return NextResponse.json({ error: 'Invalid screenshot name.' }, { status: 400 });
  }

  let candidate: string;
  try {
    candidate = join(jobPaths.screenshots(jobId), filename);
  } catch {
    return NextResponse.json({ error: 'Invalid job id.' }, { status: 400 });
  }

  const resolved = resolveWithinData(candidate);
  if (!resolved || !existsSync(resolved) || !statSync(resolved).isFile()) {
    return NextResponse.json({ error: 'Screenshot not found.' }, { status: 404 });
  }

  const stream = Readable.toWeb(createReadStream(resolved)) as ReadableStream;
  return new Response(stream, {
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(statSync(resolved).size),
      // Screenshots are immutable once written — the filename carries the attempt.
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}
