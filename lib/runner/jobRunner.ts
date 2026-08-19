/**
 * The job runner: one batch at a time, in this process.
 *
 * It does not reimplement any scraping. It calls `scrapeProducts` — the same
 * function the CLI calls — and its whole job is to decide *which* products to
 * hand it, to persist each result as it lands, and to translate the scraper's
 * callbacks into dashboard events.
 *
 * One at a time is not a simplification: the scraper is sequential by design
 * because Flipkart rate-limits hard, and running two batches concurrently would
 * trip the bot wall that the delay/back-off logic exists to avoid.
 *
 * ── Pause vs Stop ───────────────────────────────────────────────────────────
 * Both use the same AbortSignal; what differs is *when* it fires.
 *
 * Pause fires it from inside `onResult` — the callback the scraper invokes
 * after a product is finished and journalled, but before the next one starts.
 * So the in-flight product completes and is saved, and the loop exits at the
 * top of the next iteration. Nothing is lost and nothing is half-done.
 *
 * Stop fires it immediately. The scraper closes the active browser context,
 * which unblocks whatever Playwright call was in flight, and drops the torn
 * result rather than journalling it. That row stays pending and a later resume
 * scrapes it cleanly.
 */

import { resultKey } from '@/scraper/journal';
import { scrapeProducts } from '@/scraper/scraper';
import { setLogSink, setVerbose } from '@/scraper/utils';
import type { ScrapeInput, ScrapeResult, ScrapeStep } from '@/scraper/types';
import {
  clearTransientRowStatuses,
  computeStats,
  getJob,
  pendingInputs,
  prepareForRun,
  recordResult,
  setJobState,
  setRowStatus,
} from '@/lib/store/jobStore';
import { generateRecommendations } from '@/lib/services/recommendations';
import { appendLog } from '@/lib/store/logStore';
import { jobPaths } from '@/lib/store/paths';
import { DEFAULT_JOB_OPTIONS, type JobState, type LiveProgress, type LogLevel } from '@/types/dashboard';
import { publish } from './eventBus';

interface ActiveRun {
  jobId: string;
  controller: AbortController;
  /** What the user asked for. Drives the final state and when the abort fires. */
  intent: 'run' | 'pause' | 'stop';
  progress: LiveProgress | null;
  /**
   * Row indices currently being scraped.
   *
   * The fast path runs several products at once, so "what is happening now" is
   * no longer a single row. This set is what stops a finished product from
   * blanking the live panel while its neighbours are still in flight.
   */
  inFlight: Set<number>;
  /** Resolves when the background scrape settles. Used by tests and shutdown. */
  finished: Promise<void>;
}

interface RunnerState {
  active: ActiveRun | null;
}

const state: RunnerState = ((globalThis as Record<string, unknown>).__jobRunner as RunnerState) ?? {
  active: null,
};
(globalThis as Record<string, unknown>).__jobRunner = state;

export class JobRunner {
  activeJobId(): string | null {
    return state.active?.jobId ?? null;
  }

  isActive(jobId: string): boolean {
    return state.active?.jobId === jobId;
  }

  progress(): LiveProgress | null {
    return state.active?.progress ?? null;
  }

  /**
   * Begin or resume a batch. Returns as soon as the run is under way — the
   * scrape itself continues in the background for as long as it takes.
   */
  start(jobId: string): { ok: true; pending: number } | { ok: false; error: string } {
    if (state.active) {
      return state.active.jobId === jobId
        ? { ok: false, error: 'This job is already running.' }
        : { ok: false, error: `Another job (${state.active.jobId}) is running. Only one batch runs at a time.` };
    }

    const record = getJob(jobId);
    if (!record) return { ok: false, error: 'Job not found.' };

    // Drop BLOCKED rows so they are retried, healing a torn journal tail in the
    // same step. This is the CLI's --resume rule, via the CLI's own helper.
    const retrying = prepareForRun(jobId);
    if (retrying > 0) {
      this.log(jobId, 'info', `Retrying ${retrying} product(s) that were blocked on the previous run.`);
    }

    const pending = pendingInputs(jobId);
    if (pending.length === 0) {
      setJobState(jobId, 'completed', { finishedAt: new Date().toISOString() });
      this.publishState(jobId, 'completed');
      return { ok: true, pending: 0 };
    }

    const controller = new AbortController();
    const run: ActiveRun = {
      jobId,
      controller,
      intent: 'run',
      progress: null,
      inFlight: new Set<number>(),
      finished: Promise.resolve(),
    };
    state.active = run;

    const manifest = record.manifest;
    setJobState(jobId, 'running', { startedAt: manifest.startedAt ?? new Date().toISOString() });
    this.publishState(jobId, 'running');
    this.log(
      jobId,
      'step',
      `Starting: ${pending.length} product(s) to scrape of ${manifest.total} total.`,
    );

    run.finished = this.execute(run, pending);
    return { ok: true, pending: pending.length };
  }

  /** Finish the current product, save it, then stop. */
  pause(jobId: string): { ok: boolean; error?: string } {
    const run = state.active;
    if (!run || run.jobId !== jobId) return { ok: false, error: 'That job is not running.' };
    if (run.intent !== 'run') return { ok: false, error: `Already ${run.intent}ing.` };

    run.intent = 'pause';
    setJobState(jobId, 'pausing');
    this.publishState(jobId, 'pausing');
    this.log(jobId, 'warn', 'Pause requested — finishing the current product before stopping.');
    return { ok: true };
  }

  /** Stop now. The in-flight product is abandoned and left pending. */
  stop(jobId: string): { ok: boolean; error?: string } {
    const run = state.active;
    if (!run || run.jobId !== jobId) return { ok: false, error: 'That job is not running.' };

    run.intent = 'stop';
    setJobState(jobId, 'stopping');
    this.publishState(jobId, 'stopping');
    this.log(jobId, 'warn', 'Stop requested — abandoning the current product; it stays pending for resume.');
    run.controller.abort();
    return { ok: true };
  }

  /** Await the background scrape. Only useful for tests and graceful shutdown. */
  async waitForIdle(): Promise<void> {
    while (state.active) await state.active.finished;
  }

  /* ------------------------------------------------------------- internals */

  private async execute(run: ActiveRun, pending: ScrapeInput[]): Promise<void> {
    const { jobId, controller } = run;
    const record = getJob(jobId);
    if (!record) return;

    const options = record.manifest.options;
    const keyToIndex = new Map(record.rows.map((row) => [row.key, row.index]));

    // Route the scraper's own log lines into this job's log file and the live
    // viewer. Console output stays on for the terminal.
    setVerbose(true);
    setLogSink((level, message) => {
      const current = run.progress;
      this.log(jobId, level as LogLevel, message, {
        sku: current?.sku,
        fsn: current?.fsn,
        seller: current?.targetSeller,
        rowIndex: current?.rowIndex,
      });
    });

    try {
      await scrapeProducts(
        pending,
        {
          // Mapped field by field rather than spread: JobOptions is the UI's
          // shape and carries `headed`, which is not a ScraperOptions key.
          delayMs: options.delayMs,
          delayJitterMs: options.delayJitterMs,
          timeout: options.timeout,
          blockBackoffMs: options.blockBackoffMs,
          blockRetries: options.blockRetries,
          useNetworkCapture: options.useNetworkCapture,
          // Older manifests predate the fast path and carry none of these, so
          // each falls back to the scraper's own default rather than undefined.
          useFastApi: options.useFastApi ?? DEFAULT_JOB_OPTIONS.useFastApi,
          concurrency: options.concurrency ?? DEFAULT_JOB_OPTIONS.concurrency,
          requestGapMs: options.requestGapMs ?? DEFAULT_JOB_OPTIONS.requestGapMs,
          headless: !options.headed,
          verbose: true,
          screenshotOnFailureDir: jobPaths.screenshots(jobId),
          signal: controller.signal,
          onStep: (step, input) => this.onStep(run, keyToIndex, step, input),
        },
        (result) => this.onResult(run, keyToIndex, result),
      );
    } catch (error) {
      this.log(jobId, 'error', `Run failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLogSink(null);
      this.finish(run);
    }
  }

  /** Fires as a product moves through the pipeline. Keeps the live panel honest. */
  private onStep(
    run: ActiveRun,
    keyToIndex: Map<string, number>,
    step: ScrapeStep,
    input: ScrapeInput,
  ): void {
    const index = keyToIndex.get(resultKey(input)) ?? -1;

    if (index >= 0 && !run.inFlight.has(index)) {
      run.inFlight.add(index);
      setRowStatus(run.jobId, index, 'running');
    }

    run.progress = {
      jobId: run.jobId,
      rowIndex: index,
      sku: input.sku,
      fsn: input.fsn,
      targetSeller: input.targetSeller,
      productUrl: input.productUrl,
      step,
      startedAt: run.progress?.rowIndex === index ? run.progress.startedAt : new Date().toISOString(),
      browserStatus: 'scraping',
    };

    publish(run.jobId, { type: 'progress', progress: run.progress });
  }

  /**
   * A product finished. Persist it, then honour a pending pause.
   *
   * The abort is fired *here* rather than from `pause()` precisely because this
   * callback runs between products: the result is already journalled, and the
   * scraper's loop will see the abort at the top of the next iteration.
   */
  private onResult(run: ActiveRun, keyToIndex: Map<string, number>, result: ScrapeResult): void {
    const row = recordResult(run.jobId, result);
    const stats = computeStats(run.jobId);

    if (row) {
      publish(run.jobId, { type: 'row', jobId: run.jobId, row, stats });
      this.log(
        run.jobId,
        result.status === 'OK' ? 'info' : 'warn',
        result.status === 'OK'
          ? `${result.sku}: ${result.status} — page ₹${result.mainPrice}, seller ₹${result.sellerPrice}`
          : `${result.sku}: ${result.status} — ${result.message ?? 'no detail'}`,
        {
          sku: result.sku,
          fsn: result.fsn,
          seller: result.sellerName ?? undefined,
          rowIndex: row.index,
          durationMs: result.durationMs,
        },
      );
    }

    if (row) run.inFlight.delete(row.index);

    // Only clear the panel once nothing is left running. On the fast path a
    // product finishing is the normal case while five others are still going,
    // and blanking on each one would make the panel flicker empty throughout.
    if (run.inFlight.size === 0) {
      run.progress = null;
      publish(run.jobId, { type: 'progress', progress: null });
    }

    if (run.intent === 'pause') run.controller.abort();
  }

  /** Settle the job into its resting state and release the runner slot. */
  private finish(run: ActiveRun): void {
    const { jobId } = run;
    clearTransientRowStatuses(jobId);

    const stats = computeStats(jobId);
    const everythingDone = stats.pending === 0 && stats.running === 0;

    let next: JobState;
    if (everythingDone) next = 'completed';
    else if (run.intent === 'pause') next = 'paused';
    else if (run.intent === 'stop') next = 'stopped';
    // The loop ended on its own with work left: the scraper gave up after
    // exhausting its block back-offs. Resumable, but not a user's choice.
    else next = 'stopped';

    setJobState(jobId, next, everythingDone ? { finishedAt: new Date().toISOString() } : {});

    if (!everythingDone && run.intent === 'run') {
      this.log(jobId, 'error', `Run ended early with ${stats.pending} product(s) left — most likely a persistent block. Resume to continue.`);
    } else {
      this.log(jobId, 'step', `Run ${next}: ${stats.succeeded} OK, ${stats.failed} failed, ${stats.pending} pending.`);
    }

    // Recommendations are generated here, once, at the end of a run — never when
    // the page is viewed. A resumed run ends here too, so the saved file always
    // reflects everything that has actually been scraped.
    if (stats.completed > 0) {
      try {
        const file = generateRecommendations(jobId);
        if (file) this.log(jobId, 'step', `Recommendations ready — ${file.summary}`);
      } catch (error) {
        this.log(
          jobId,
          'warn',
          `Could not generate recommendations: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    run.progress = null;
    run.inFlight.clear();
    state.active = null;

    publish(jobId, { type: 'progress', progress: null });
    this.publishState(jobId, next);
  }

  private publishState(jobId: string, jobState: JobState): void {
    publish(jobId, { type: 'state', jobId, state: jobState, stats: computeStats(jobId) });
  }

  private log(
    jobId: string,
    level: LogLevel,
    message: string,
    context: Parameters<typeof appendLog>[3] = {},
  ): void {
    if (!message.trim()) return;
    const entry = appendLog(jobId, level, message, context);
    publish(jobId, { type: 'log', entry });
  }
}

const runner = ((globalThis as Record<string, unknown>).__jobRunnerInstance as JobRunner) ?? new JobRunner();
(globalThis as Record<string, unknown>).__jobRunnerInstance = runner;

export function getRunner(): JobRunner {
  return runner;
}
