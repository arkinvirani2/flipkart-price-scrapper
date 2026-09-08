'use client';

/**
 * The factory reset, as a button.
 *
 * Two things make this more than a "delete all batches" convenience. The first
 * is that it clears state the user has no other way to reach — orphaned
 * Playwright browsers and their temp profiles, which quietly tax every later
 * run because the worker pool sizes itself on measured throughput and reads a
 * loaded machine as a slow one. The second is that it clears the *browser*
 * side too, so the dashboard in front of the user genuinely comes back empty
 * rather than re-rendering a cached copy of what was just deleted.
 *
 * The order is server, then browser, then reload — never the reverse. Clearing
 * the tab first would throw away the only place the outcome could be shown if
 * the server call then failed.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import type { ResetReport } from '@/lib/api';
import { clearBrowserState } from '@/lib/browserReset';

/**
 * How long the summary stays on screen before the page reloads.
 *
 * A reset that reloaded instantly would be indistinguishable from a button that
 * does nothing — the user needs to see that four batches and two stray browsers
 * actually went.
 */
const RELOAD_DELAY_MS = 2_500;

export function ResetEverythingButton({ activeJobId }: { activeJobId: string | null }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<ResetReport | null>(null);

  const reset = useMutation({
    mutationFn: async () => {
      const { report: serverReport } = await api.resetEverything();
      const browser = await clearBrowserState();

      // The client cache is emptied rather than invalidated: invalidation would
      // immediately refetch against a server that is mid-reset, repopulating
      // the very lists this just cleared.
      queryClient.clear();

      return {
        ...serverReport,
        warnings: [...serverReport.warnings, ...browser.warnings],
      } satisfies ResetReport;
    },
    onSuccess: (result) => {
      setReport(result);
      // A hard reload rather than a router refresh: the point is that nothing
      // in this document survives, including module-level state React Query
      // knows nothing about.
      setTimeout(() => window.location.reload(), RELOAD_DELAY_MS);
    },
  });

  const busy = reset.isPending || reset.isSuccess;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={() => {
          setReport(null);
          reset.reset();
          setOpen(true);
        }}
      >
        <Trash2 /> Reset everything
      </Button>

      <Dialog
        open={open}
        // Not closable while it runs: half of this is irreversible by the time
        // the dialog would close, and the summary is the only record of it.
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Reset everything and start fresh</DialogTitle>
            <DialogDescription>
              This cannot be undone. Export anything you still need before continuing.
            </DialogDescription>
          </DialogHeader>

          {report ? (
            <ResetSummary report={report} />
          ) : (
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">What gets erased:</p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>Every uploaded batch — rows, results, recommendations and screenshots</li>
                <li>Every log file and the live log buffers held in memory</li>
                <li>All learned account history used to price future uploads</li>
                <li>Leftover scraper browsers still running, and their temporary profiles</li>
                <li>This browser&apos;s stored data for the dashboard, then a reload</li>
              </ul>
              <p className="text-muted-foreground">
                Your uploaded spreadsheets on your own disk, the installed browser and
                node_modules are left alone.
              </p>

              {activeJobId && (
                <Alert variant="warning">
                  <AlertTriangle />
                  <AlertTitle>A batch is running right now</AlertTitle>
                  <AlertDescription>
                    It will be stopped first, and then deleted along with everything it has
                    already scraped.
                  </AlertDescription>
                </Alert>
              )}

              {reset.error && (
                <Alert variant="destructive">
                  <AlertTitle>Reset failed</AlertTitle>
                  <AlertDescription>{(reset.error as Error).message}</AlertDescription>
                </Alert>
              )}
            </div>
          )}

          <DialogFooter>
            {report ? (
              <Button type="button" onClick={() => window.location.reload()}>
                Reload now
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => reset.mutate()}
                >
                  {reset.isPending ? (
                    <>
                      <Loader2 className="animate-spin" /> Erasing…
                    </>
                  ) : (
                    <>
                      <Trash2 /> Erase everything
                    </>
                  )}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** What actually went, so the reset is verifiable rather than merely claimed. */
function ResetSummary({ report }: { report: ResetReport }) {
  const lines: string[] = [
    `${report.batchesDeleted} batch${report.batchesDeleted === 1 ? '' : 'es'} deleted`,
    `${report.accountsDeleted} account histor${report.accountsDeleted === 1 ? 'y' : 'ies'} cleared`,
    `${report.browserProcessesKilled} leftover browser${report.browserProcessesKilled === 1 ? '' : 's'} stopped`,
    `${report.tempProfilesRemoved} temporary profile${report.tempProfilesRemoved === 1 ? '' : 's'} removed`,
  ];
  if (report.scratchFilesRemoved.length > 0) {
    lines.push(`Removed ${report.scratchFilesRemoved.join(', ')}`);
  }
  if (report.stoppedJobId) {
    lines.push(
      report.stopTimedOut
        ? `The running batch did not stop cleanly — check for stray browsers`
        : `Stopped the running batch first`,
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <p className="font-medium">Done — reloading in a moment.</p>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      {report.warnings.length > 0 && (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertTitle>Cleared, with {report.warnings.length} note(s)</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-5">
              {report.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
