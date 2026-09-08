'use client';

import { useMutation } from '@tanstack/react-query';
import { Loader2, Play } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { UploadDropzone } from '@/components/upload/UploadDropzone';
import { ValidationReport } from '@/components/upload/ValidationReport';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { DEFAULT_JOB_OPTIONS, MAX_CONCURRENCY } from '@/types/dashboard';
import type { ValidationReport as Report } from '@/lib/validation/uploadSchema';

export default function UploadPage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [minimumFile, setMinimumFile] = useState<File | null>(null);
  const [account, setAccount] = useState('');
  const [name, setName] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const validate = useMutation({
    mutationFn: () => api.validateUpload(file!, minimumFile!, account.trim()),
    onSuccess: ({ report: next }) => setReport(next),
  });
  // Fixed at creation, because it is stored on the manifest and a resumed run
  // reads it back from there — a batch scrapes with the pool it was made with.
  const [workers, setWorkers] = useState(DEFAULT_JOB_OPTIONS.concurrency);
  // Off by default: the adaptive pool is the safer answer on an unknown host,
  // and this is the switch that says "I know what this machine can take".
  const [fixedWorkers, setFixedWorkers] = useState(false);
  const create = useMutation({
    mutationFn: () => api.createJob({
      name,
      accountName: account.trim(),
      rows: report?.rows ?? [],
      options: { ...DEFAULT_JOB_OPTIONS, concurrency: workers, adaptiveConcurrency: !fixedWorkers },
    }),
    onSuccess: ({ job }) => router.push(`/jobs/${job.id}`),
  });

  return <div className="w-full space-y-6 p-4 xl:p-5">
    <header><h1 className="text-xl font-semibold">New batch</h1><p className="mt-1 text-sm text-muted-foreground">Add products for one Flipkart account.</p></header>
    <div className="space-y-2"><Label htmlFor="account">Flipkart account</Label><Input id="account" value={account} onChange={(event) => { setAccount(event.target.value); setReport(null); }} placeholder="e.g. Anuttar" /></div>
    <UploadDropzone onFile={(next) => { setFile(next); setReport(null); if (!name) setName(next.name.replace(/\.(xlsx?|json)$/i, '')); }} disabled={!account.trim() || validate.isPending || create.isPending} filename={file?.name ?? null} title="Drop listing data (sheet 1), or click to browse" description="Needs: SKU Seller ID, FSN, Current Bank Settlement" />
    <UploadDropzone onFile={(next) => { setMinimumFile(next); setReport(null); }} disabled={!account.trim() || validate.isPending || create.isPending} filename={minimumFile?.name ?? null} title="Drop minimum bank settlement (sheet 2), or click to browse" description="Needs: SKU, Minimum Bank Settlement price" />
    <Button onClick={() => validate.mutate()} disabled={!file || !minimumFile || !account.trim() || validate.isPending}>{validate.isPending ? <Loader2 className="animate-spin" /> : <Play />} Validate table</Button>
    {validate.isError && <Alert variant="destructive"><AlertTitle>Upload failed</AlertTitle><AlertDescription>{(validate.error as Error).message}</AlertDescription></Alert>}
    {report && <ValidationReport report={report} />}
    {report?.ok && <div className="space-y-3 rounded-lg border p-4">
      <Label htmlFor="name">Batch name</Label>
      <Input id="name" value={name} onChange={(event) => setName(event.target.value)} />
      <Label htmlFor="workers">Workers</Label>
      <Input id="workers" type="number" min={1} max={MAX_CONCURRENCY} value={workers}
        onChange={(event) => setWorkers(Math.min(MAX_CONCURRENCY, Math.max(1, Math.trunc(Number(event.target.value)) || 1)))} />
      <p className="text-xs text-muted-foreground">
        Products scraped at once, each in its own browser window — {MAX_CONCURRENCY} is the maximum.
        More workers finish the batch faster and put proportionally more traffic on Flipkart from one
        address, so if a batch comes back with an unusual number of failures, rerun the failed rows on
        a smaller pool before trusting the result.
      </p>

      <div className="flex items-start justify-between gap-4 rounded-md border p-3">
        <div className="space-y-1">
          <Label htmlFor="fixed-workers">Hold all {workers} workers open</Label>
          <p className="text-xs text-muted-foreground">
            {fixedWorkers
              ? `All ${workers} workers scrape for the whole batch. Timeouts are widened to match, but a host that cannot render ${workers} pages at once will fail products rather than slow down — check the failure count on the first run.`
              : `Off, the pool sizes itself: it opens at this machine's core count and widens only while that measurably helps, so a batch asking for ${workers} often runs 5-8 wide. Turn on to run exactly ${workers}.`}
          </p>
        </div>
        <Switch
          id="fixed-workers"
          checked={fixedWorkers}
          onCheckedChange={setFixedWorkers}
          aria-label={`Hold all ${workers} workers open for the whole batch`}
        />
      </div>
      <Button className="w-full" onClick={() => create.mutate()} disabled={create.isPending}>{create.isPending ? <Loader2 className="animate-spin" /> : <Play />} Create batch</Button>
    </div>}
  </div>;
}
