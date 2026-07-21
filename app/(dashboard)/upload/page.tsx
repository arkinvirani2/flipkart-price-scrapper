'use client';

import { useMutation } from '@tanstack/react-query';
import { Loader2, Play } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { UploadDropzone } from '@/components/upload/UploadDropzone';
import { ValidationReport } from '@/components/upload/ValidationReport';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { DEFAULT_JOB_OPTIONS, type JobOptions } from '@/types/dashboard';
import type { ValidationReport as Report } from '@/lib/validation/uploadSchema';

export default function UploadPage() {
  const router = useRouter();
  const [filename, setFilename] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [name, setName] = useState('');
  const [options, setOptions] = useState<JobOptions>(DEFAULT_JOB_OPTIONS);

  const validate = useMutation({
    mutationFn: (file: File) => api.validateUpload(file),
    onSuccess: (data) => {
      setFilename(data.filename);
      setReport(data.report);
      if (!name) setName(data.filename.replace(/\.json$/i, ''));
    },
  });

  const create = useMutation({
    mutationFn: () => api.createJob({ name, rows: report?.rows ?? [], options }),
    onSuccess: ({ job }) => router.push(`/jobs/${job.id}`),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">New batch</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload a JSON file, review what was found, then start scraping.
        </p>
      </header>

      <UploadDropzone
        onFile={(file) => validate.mutate(file)}
        disabled={validate.isPending || create.isPending}
        filename={filename}
      />

      {validate.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Validating…
        </p>
      )}

      {validate.isError && (
        <Alert variant="destructive">
          <AlertTitle>Upload failed</AlertTitle>
          <AlertDescription>{(validate.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {report && <ValidationReport report={report} />}

      {report?.ok && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Batch settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="job-name">Name</Label>
              <Input
                id="job-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Weekly price check"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="delay">Delay between products (ms)</Label>
                <Input
                  id="delay"
                  type="number"
                  min={0}
                  step={100}
                  value={options.delayMs}
                  onChange={(event) =>
                    setOptions({ ...options, delayMs: Math.max(0, Number(event.target.value) || 0) })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  1500 or more is strongly advised past a few hundred products — this is what keeps
                  Flipkart from rate-limiting the run.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="timeout">Per-action timeout (ms)</Label>
                <Input
                  id="timeout"
                  type="number"
                  min={1000}
                  step={1000}
                  value={options.timeout}
                  onChange={(event) =>
                    setOptions({ ...options, timeout: Math.max(1000, Number(event.target.value) || 20000) })
                  }
                />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="headed" className="cursor-pointer">
                  Show the browser window
                </Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  Useful for debugging a stubborn product. Only works because this runs on your own
                  machine.
                </p>
              </div>
              <Switch
                id="headed"
                checked={options.headed}
                onCheckedChange={(checked) => setOptions({ ...options, headed: checked })}
              />
            </div>

            <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
              Estimated run time for {report.rows.length} products:{' '}
              <span className="tabular font-medium text-foreground">
                {estimateRuntime(report.rows.length, options.delayMs)}
              </span>{' '}
              — assuming roughly 5s per product plus the delay.
            </div>

            {create.isError && (
              <Alert variant="destructive">
                <AlertTitle>Could not create the batch</AlertTitle>
                <AlertDescription>{(create.error as Error).message}</AlertDescription>
              </Alert>
            )}

            <Button onClick={() => create.mutate()} disabled={create.isPending} className="w-full">
              {create.isPending ? <Loader2 className="animate-spin" /> : <Play />}
              Create batch
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Rough, and labelled as rough — a precise number here would be a fiction. */
function estimateRuntime(count: number, delayMs: number): string {
  const totalMs = count * (5_000 + delayMs);
  const minutes = totalMs / 60_000;

  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `about ${Math.round(minutes)} minutes`;
  return `about ${(minutes / 60).toFixed(1)} hours`;
}
