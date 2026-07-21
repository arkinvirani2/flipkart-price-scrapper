/**
 * GET /api/jobs/:jobId/events — server-sent events for one batch.
 *
 * SSE rather than WebSockets: the traffic is entirely server→client, and SSE
 * needs no extra server, no upgrade handshake, and reconnects on its own.
 *
 * Rather than polling — which at 1000 rows would mean shipping the whole table
 * every second — each finished row is pushed once, as it lands.
 */

import { publish, subscribe } from '@/lib/runner/eventBus';
import { getRunner } from '@/lib/runner/jobRunner';
import { computeStats, getJob } from '@/lib/store/jobStore';
import type { JobEvent } from '@/types/dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Proxies and browsers drop a silent connection. A comment line every 20s keeps
 * it open without polluting the event stream.
 */
const HEARTBEAT_MS = 20_000;

type Context = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { jobId } = await params;

  if (!getJob(jobId)) {
    return new Response('Job not found', { status: 404 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (event: JobEvent): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Prime the connection so a tab that opens mid-run renders immediately
      // instead of waiting for the next product to finish.
      const runner = getRunner();
      const record = getJob(jobId);
      if (record) {
        send({ type: 'state', jobId, state: record.manifest.state, stats: computeStats(jobId) });
        send({ type: 'progress', progress: runner.isActive(jobId) ? runner.progress() : null });
      }

      const unsubscribe = subscribe(jobId, send);

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_MS);

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already torn down by the runtime.
        }
      };

      request.signal.addEventListener('abort', cleanup, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tells nginx and friends not to buffer, which would defeat the point.
      'X-Accel-Buffering': 'no',
    },
  });
}

/** Exported for the runner's tests; not used by the route itself. */
export { publish };
