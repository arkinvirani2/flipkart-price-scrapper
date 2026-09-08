/**
 * The factory reset: everything this project has written, in one call.
 *
 * The button behind this exists because scraper state does not only live in
 * `data/`. A run that ended badly leaves three other kinds of residue, and all
 * three cost throughput on the *next* run rather than the one that made them:
 *
 *   1. Chromium processes that outlived their run. Playwright launches a real
 *      browser per pool; if the Node process is killed rather than shut down,
 *      those children are re-parented and keep running. They cost CPU forever
 *      after, and because the pool sizes itself on measured throughput (see
 *      scraper/poolWidth.ts) a machine quietly hosting a dozen orphaned
 *      renderers is *measured* as a slow machine — the pool narrows to five or
 *      six workers and stays there, whatever concurrency the user asked for.
 *   2. The temporary browser profiles those launches created under the system
 *      temp directory, which nothing deletes if the browser was killed.
 *   3. The dashboard's own in-memory indexes, which are pinned to globalThis so
 *      they survive Next's dev-mode module reloading — and therefore also
 *      survive deleting the files underneath them.
 *
 * Deleting job data alone would leave 1 and 2 in place, which is exactly the
 * part a user cannot clear by hand. So this clears all three, and the client
 * clears the browser's own storage on top. What it never touches: node_modules,
 * the Playwright browser *installation*, and anything outside this project's
 * data directory and its own temp files.
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { clearSubscribers } from '@/lib/runner/eventBus';
import { getRunner } from '@/lib/runner/jobRunner';
import { resetAllAccounts } from '@/lib/intelligence/store';
import { resetRecoveryLatch } from '@/lib/services/recovery';
import { deleteAllJobs } from '@/lib/store/jobStore';
import { clearAllLogs } from '@/lib/store/logStore';
import { dataDir } from '@/lib/store/paths';

const run = promisify(execFile);

/** How long to wait for a running batch to tear down before giving up on it. */
const STOP_TIMEOUT_MS = 30_000;

/** Ceiling on the browser sweep, so a reset always returns. */
const KILL_TIMEOUT_MS = 20_000;

export interface ResetReport {
  /** The batch that was stopped to make the reset possible, if there was one. */
  stoppedJobId: string | null;
  /** True if that batch did not finish tearing down inside STOP_TIMEOUT_MS. */
  stopTimedOut: boolean;
  batchesDeleted: number;
  accountsDeleted: number;
  /** Leftover Playwright profile directories removed from the system temp dir. */
  tempProfilesRemoved: number;
  /** Orphaned Playwright browser processes killed. */
  browserProcessesKilled: number;
  /** Loose scratch files removed from the project root. */
  scratchFilesRemoved: string[];
  /** Anything that failed, named rather than swallowed. */
  warnings: string[];
}

/**
 * Wipe everything and report what went.
 *
 * Ordered deliberately: the run stops first (nothing else is safe while a pool
 * is writing), then files, then memory, then the system residue. The later
 * steps are best-effort — a temp directory another program is holding open must
 * not fail a reset that has already deleted the data it was asked to.
 */
export async function resetEverything(): Promise<ResetReport> {
  const warnings: string[] = [];

  const { stoppedJobId, stopTimedOut } = await stopActiveRun(warnings);

  let batchesDeleted = 0;
  let accountsDeleted = 0;
  try {
    batchesDeleted = deleteAllJobs();
    accountsDeleted = resetAllAccounts();
  } catch (error) {
    warnings.push(`Could not fully clear ${dataDir()}: ${message(error)}`);
  }

  // After the files, never before: these indexes rebuild themselves lazily from
  // disk, so clearing them while the directories still existed would refill them.
  clearAllLogs();
  clearSubscribers();
  resetRecoveryLatch();

  const browserProcessesKilled = await killStrayBrowsers(warnings);
  // Only once the processes holding them are gone — a live browser keeps its
  // profile directory locked on Windows and the removal would fail.
  const tempProfilesRemoved = removeTempProfiles(warnings);
  const scratchFilesRemoved = removeScratchFiles(warnings);

  return {
    stoppedJobId,
    stopTimedOut,
    batchesDeleted,
    accountsDeleted,
    tempProfilesRemoved,
    browserProcessesKilled,
    scratchFilesRemoved,
    warnings,
  };
}

/* --------------------------------------------------------------- the run */

/**
 * Stop whatever is running, and wait for it to actually let go.
 *
 * Stop rather than pause, and awaited rather than fired: the point of a reset is
 * that nothing holds a file handle or a browser when the deleting starts. The
 * wait is bounded because a wedged Playwright call could otherwise hang the
 * request indefinitely; if it expires the reset continues anyway and says so in
 * the report, which is the honest outcome — the files go, and the straggler is
 * caught by the browser sweep below.
 */
async function stopActiveRun(
  warnings: string[],
): Promise<{ stoppedJobId: string | null; stopTimedOut: boolean }> {
  const runner = getRunner();
  const jobId = runner.activeJobId();
  if (!jobId) return { stoppedJobId: null, stopTimedOut: false };

  runner.stop(jobId);

  const expired = Symbol('timeout');
  const timer = new Promise<typeof expired>((resolve) => {
    setTimeout(() => resolve(expired), STOP_TIMEOUT_MS).unref?.();
  });
  const settled = await Promise.race([runner.waitForIdle().then(() => 'idle' as const), timer]);

  if (settled === expired) {
    warnings.push(
      `Batch ${jobId} did not stop within ${STOP_TIMEOUT_MS / 1000}s; the reset continued without it.`,
    );
    return { stoppedJobId: jobId, stopTimedOut: true };
  }

  return { stoppedJobId: jobId, stopTimedOut: false };
}

/* ---------------------------------------------------------- system level */

/**
 * Where Playwright keeps the browsers it downloaded.
 *
 * Matched on rather than deleted: it is the one reliable way to tell a browser
 * this project launched from the user's own Chrome, and killing the latter
 * because it happens to share a process name would be unforgivable.
 */
function playwrightBrowsersRoot(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;

  const home = homedir();
  if (process.platform === 'win32') return join(home, 'AppData', 'Local', 'ms-playwright');
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright');
  return join(home, '.cache', 'ms-playwright');
}

/**
 * Kill browser processes running out of the Playwright install.
 *
 * The path prefix is the entire safety argument. Every process killed here was
 * started from a binary inside `ms-playwright`, which nothing but Playwright
 * launches — so an ordinary Chrome window, an Edge window, or a Chromium the
 * user installed themselves is not a candidate, whatever it is called.
 *
 * A reset only ever reaches this point with no batch active (the run was
 * stopped above), so anything still matching is by definition an orphan.
 */
async function killStrayBrowsers(warnings: string[]): Promise<number> {
  const root = playwrightBrowsersRoot();
  if (!existsSync(root)) return 0;

  try {
    return process.platform === 'win32'
      ? await killStrayBrowsersWindows(root)
      : await killStrayBrowsersPosix(root);
  } catch (error) {
    // Never fatal: the data is already gone, and a machine where we cannot
    // enumerate processes is still better off than it was before the reset.
    warnings.push(`Could not sweep leftover browser processes: ${message(error)}`);
    return 0;
  }
}

async function killStrayBrowsersWindows(root: string): Promise<number> {
  // CIM rather than `taskkill /IM`: taskkill matches on image name and cannot
  // tell our browser from the user's own, so it would close their tabs.
  //
  // Nothing is filtered on process name, deliberately. Playwright's headless
  // browser is `chrome-headless-shell.exe`, its headed one is `chrome.exe`, and
  // the names have changed across releases — a name list is a filter that
  // silently stops matching after an upgrade. The executable path is both the
  // safety guarantee and a complete one, so it is the only test.
  //
  // The root is embedded as a literal rather than passed as an argument:
  // `powershell -Command` treats everything after the script as *more script*,
  // so a trailing `-args <path>` binds to the last cmdlet in the pipeline
  // instead of filling `$args`, and the whole command fails to parse.
  const script = [
    `$root = ${psLiteral(root)}`,
    'Get-CimInstance Win32_Process |',
    '  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) } |',
    '  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; 1 } catch { } } |',
    '  Measure-Object | Select-Object -ExpandProperty Count',
  ].join('\n');

  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: KILL_TIMEOUT_MS, windowsHide: true },
  );
  return Number.parseInt(stdout.trim(), 10) || 0;
}

/**
 * A path as a single-quoted PowerShell string.
 *
 * Single-quoted because PowerShell expands `$` inside double quotes, and a
 * Windows profile directory is allowed to contain one — a double-quoted literal
 * would silently truncate the path there, leaving a prefix so short that every
 * Chrome on the machine matched it.
 */
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function killStrayBrowsersPosix(root: string): Promise<number> {
  // -f matches the full command line, so the same path-prefix rule applies.
  const { stdout } = await run('pgrep', ['-f', root], { timeout: KILL_TIMEOUT_MS }).catch(
    // pgrep exits 1 when nothing matched, which is a normal result, not an error.
    () => ({ stdout: '' }),
  );

  const pids = stdout
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);

  let killed = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
      killed += 1;
    } catch {
      // Already gone, or not ours to kill. Either way there is nothing to do.
    }
  }
  return killed;
}

/**
 * Playwright's throwaway profile directories, left behind by killed browsers.
 *
 * Each one is a full Chromium profile — cache, cookies, service workers — and a
 * batch that crashed repeatedly can leave gigabytes of them. Matched by
 * Playwright's own naming, so nothing else in the temp directory is at risk.
 */
function removeTempProfiles(warnings: string[]): number {
  const temp = tmpdir();
  let removed = 0;

  let entries: string[];
  try {
    entries = readdirSync(temp);
  } catch (error) {
    warnings.push(`Could not read the system temp directory: ${message(error)}`);
    return 0;
  }

  for (const entry of entries) {
    if (!/^\.?playwright[-_]/i.test(entry)) continue;

    const path = join(temp, entry);
    try {
      if (!statSync(path).isDirectory()) continue;
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Still held open by a process that outlived the sweep above, most
      // likely. Skipped rather than reported: it is temp, and it gets reused.
    }
  }

  return removed;
}

/**
 * The CLI's scratch output in the project root.
 *
 * `npm run scrape` writes these next to the source, outside `data/`, and a
 * stale results.ndjson is a resume checkpoint the CLI will happily pick up — so
 * a "start fresh" that left them behind would not have started fresh.
 */
function removeScratchFiles(warnings: string[]): string[] {
  const removed: string[] = [];

  for (const name of ['results.json', 'results.ndjson']) {
    const path = join(process.cwd(), name);
    if (!existsSync(path)) continue;
    try {
      rmSync(path, { force: true });
      removed.push(name);
    } catch (error) {
      warnings.push(`Could not remove ${name}: ${message(error)}`);
    }
  }

  return removed;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
