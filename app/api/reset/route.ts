/**
 * POST /api/reset — erase every batch, log, learned history and browser
 * leftover this project has produced, and hand back an account of what went.
 *
 * POST rather than DELETE because it is not addressing a resource: it stops a
 * running batch, kills processes and clears memory as well as deleting files.
 *
 * Deliberately unconditional. The confirmation lives in the UI, where the user
 * can read what is about to happen; a server-side guard here ("refuse while a
 * job is running") would only turn the reset into a two-step dance in exactly
 * the situation people reach for it — a run that has gone wrong and needs to be
 * abandoned.
 */

import { NextResponse } from 'next/server';
import { resetEverything } from '@/lib/services/systemReset';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const report = await resetEverything();
    return NextResponse.json({ report });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Reset failed.' },
      { status: 500 },
    );
  }
}
