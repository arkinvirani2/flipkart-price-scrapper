/**
 * Crash recovery.
 *
 * Nothing in this file repairs data — it does not have to. The journal is
 * appended before the next product starts, so every completed product is
 * already durable no matter how the process died. All that is left is to notice
 * that a job claims to be running when no runner exists, and to say so.
 *
 * Runs once per server start, and is safe to run again.
 */

import { ACTIVE_STATES, type JobManifest } from '@/types/dashboard';
import { getRunner } from '@/lib/runner/jobRunner';
import { invalidate, listJobs, setJobState } from '@/lib/store/jobStore';
import { appendLog } from '@/lib/store/logStore';

/**
 * Pinned to globalThis, not a module-level `let`.
 *
 * Next compiles route handlers into separate module instances, so a plain
 * module variable is "once per route", not "once per process" — which meant
 * recovery re-ran on a later route hit and flagged a *running* job as crashed.
 */
function alreadyRan(): boolean {
  return Boolean((globalThis as Record<string, unknown>).__recoveryDone);
}

function markRan(): void {
  (globalThis as Record<string, unknown>).__recoveryDone = true;
}

export interface RecoveryReport {
  interrupted: JobManifest[];
}

/**
 * Flag jobs that were mid-run when the process stopped.
 *
 * A manifest saying `running` after a fresh boot can only mean the process died
 * — the runner is in-memory and cannot have survived. The row that was in
 * flight was never journalled (the scraper drops an aborted product rather than
 * recording a torn one), so it is still pending and will be picked up by a
 * resume untouched.
 */
export function recoverInterruptedJobs(): RecoveryReport {
  const interrupted: JobManifest[] = [];

  const runner = getRunner();

  for (const manifest of listJobs()) {
    if (!ACTIVE_STATES.includes(manifest.state)) continue;

    // The decisive check: a job the in-process runner is actively driving has
    // not crashed, whatever its manifest says. Without this, any request that
    // triggered recovery would declare the live run dead underneath itself.
    if (runner.isActive(manifest.id)) continue;

    invalidate(manifest.id);
    const updated = setJobState(manifest.id, 'interrupted', {
      interruptedAt: new Date().toISOString(),
    });

    if (updated) {
      interrupted.push(updated);
      appendLog(
        manifest.id,
        'warn',
        `Job was ${manifest.state} when the server stopped. Completed products are safe; resume to continue.`,
      );
    }
  }

  return { interrupted };
}

/** Idempotent wrapper — route handlers can call this freely. */
export function ensureRecovered(): RecoveryReport {
  if (alreadyRan()) return { interrupted: [] };
  markRan();
  return recoverInterruptedJobs();
}

/**
 * Arm recovery to run again.
 *
 * Only the full reset needs this. Recovery's once-per-process latch is correct
 * for the lifetime of a server, but a reset ends one era of data and starts
 * another; leaving the latch set would mean the first job of the new era could
 * never be recognised as interrupted if the process died on it.
 */
export function resetRecoveryLatch(): void {
  delete (globalThis as Record<string, unknown>).__recoveryDone;
}
