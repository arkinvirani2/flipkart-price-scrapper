/**
 * The job runner: one batch at a time, in this process.
 *
 * It does not reimplement any scraping. It calls `scrapeProducts` — the same
 * function the CLI calls — and its whole job is to decide *which* products to
 * hand it, to persist each result as it lands, and to translate the scraper's
 * callbacks into dashboard events.
 *
 * One JOB at a time is not a simplification: two batches at once would multiply
 * the request rate against a host that rate-limits hard, with nothing
 * coordinating their back-offs. Within a job the scraper runs
 * `options.concurrency` workers, which share one block gate and are paced
 * per worker — bounded in a way two uncoordinated jobs would not be.
 *
 * ── Pause vs Stop ───────────────────────────────────────────────────────────
 * Both use the same AbortSignal; what differs is *when* it fires.
 *
 * Pause does not fire the signal at all — it sets the run's intent, and the
 * scraper's `shouldStop` hook reads that before a worker picks up its next
 * product. Every worker finishes and journals the product it is holding, then
 * exits. Nothing is lost and nothing is half-done.
 *
 * Firing the signal for a Pause would be wrong under a worker pool: it closes
 * every active context, so the two products the OTHER workers were part-way
 * through would be torn up and abandoned, when the user asked only to stop after
 * the current one.
 *
 * Stop fires the signal immediately, which is exactly that tear-down, and is
 * what Stop means. The scraper closes the active contexts, unblocking whatever
 * Playwright calls were in flight, and drops the torn results rather than
 * journalling them. Those rows stay pending and a later resume scrapes them
 * cleanly.
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
import type { JobState, LiveProgress, LogLevel } from '@/types/dashboard';
import { publish } from './eventBus';

interface ActiveRun {
  jobId: string;
  controller: AbortController;
  /** What the user asked for. Drives the final state and when the abort fires. */
  intent: 'run' | 'pause' | 'stop';
  /**
   * One live slot per worker, keyed by worker id.
   *
   * A Map rather than a single field because several products are genuinely in
   * flight at once; a lone slot would flicker between them and under-report what
   * the run is doing.
   */
  progress: Map<number, LiveProgress>;
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

  /** Every product currently in flight, ordered by worker id for a stable UI. */
  progress(): LiveProgress[] {
    if (!state.active) return [];
    return [...state.active.progress.values()].sort((a, b) => a.workerId - b.workerId);
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
      progress: new Map(),
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

    // Setting the intent is the whole mechanism: `shouldStop` reports it to the
    // scraper, which stops handing out work. Every in-flight product still runs
    // to completion and is journalled.
    run.intent = 'pause';
    setJobState(jobId, 'pausing');
    this.publishState(jobId, 'pausing');
    this.log(
      jobId,
      'warn',
      'Pause requested — finishing the products already in flight before stopping.',
    );
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
    setLogSink((level, message, workerId) => {
      // Attribute the line to the product THAT worker is on. Reading a single
      // "current product" here would tag every line with whichever worker
      // happened to report last, quietly filing failures under the wrong SKU.
      const current = run.progress.get(workerId);
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
          concurrency: options.concurrency,
          blockResources: options.blockResources,
          useNetworkCapture: options.useNetworkCapture,
          headless: !options.headed,
          verbose: true,
          screenshotOnFailureDir: jobPaths.screenshots(jobId),
          signal: controller.signal,
          // Pause drains; only Stop aborts. See the note at the top of the file.
          shouldStop: () => run.intent !== 'run',
          onStep: (step, input, workerId) => this.onStep(run, keyToIndex, step, input, workerId),
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
    workerId: number,
  ): void {
    const index = keyToIndex.get(resultKey(input)) ?? -1;
    const previous = run.progress.get(workerId);

    if (previous?.rowIndex !== index && index >= 0) {
      setRowStatus(run.jobId, index, 'running');
    }

    run.progress.set(workerId, {
      jobId: run.jobId,
      workerId,
      rowIndex: index,
      sku: input.sku,
      fsn: input.fsn,
      targetSeller: input.targetSeller,
      productUrl: input.productUrl,
      step,
      // Keep the original start time while this worker stays on this row, so the
      // elapsed timer measures the product rather than the latest step.
      startedAt: previous?.rowIndex === index ? previous.startedAt : new Date().toISOString(),
      browserStatus: 'scraping',
    });

    publish(run.jobId, { type: 'progress', progress: this.progress() });
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
    } else {
      // The journal took the line but no row answers to its key, so nothing in
      // the dashboard will ever show this product's result. That should be
      // impossible — the key is sku + productUrl, both echoed back from the
      // input — and it stays silent without this, which is exactly the kind of
      // loss a wide pool would be blamed for. Say it out loud instead.
      this.log(
        run.jobId,
        'error',
        `${result.sku}: result could not be matched to any row in this batch (key "${resultKey(result)}") — it is journalled but not shown.`,
        { sku: result.sku, fsn: result.fsn },
      );
    }

    // Free just this product's slot. Clearing the whole map would blank the
    // other workers, which are still mid-product.
    //
    // Matched on the product rather than on the row index alone, because
    // `recordResult` returns null for a key it does not recognise — and a slot
    // that never clears would leave a finished product on screen until the run
    // ends.
    for (const [workerId, live] of run.progress) {
      const sameRow = row != null && live.rowIndex === row.index;
      const sameProduct = live.sku === result.sku && live.productUrl === result.productUrl;
      if (sameRow || sameProduct) run.progress.delete(workerId);
    }
    publish(run.jobId, { type: 'progress', progress: this.progress() });
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

    run.progress.clear();
    state.active = null;

    publish(jobId, { type: 'progress', progress: [] });
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
