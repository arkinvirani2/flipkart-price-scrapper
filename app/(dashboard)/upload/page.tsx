'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2, Play } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { UploadDropzone } from '@/components/upload/UploadDropzone';
import { ValidationReport } from '@/components/upload/ValidationReport';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { api, type OrdersReport } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { DEFAULT_JOB_OPTIONS, type JobOptions } from '@/types/dashboard';
import type { ValidationReport as Report } from '@/lib/validation/uploadSchema';

/** Sentinel for the "add an account" option — never a real account name. */
const NEW_ACCOUNT = '__new__';

export default function UploadPage() {
  const router = useRouter();
  const [listingFile, setListingFile] = useState<File | null>(null);
  const [thresholdFile, setThresholdFile] = useState<File | null>(null);
  const [ordersFile, setOrdersFile] = useState<File | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [orders, setOrders] = useState<OrdersReport | null>(null);
  const [name, setName] = useState('');
  const [targetSeller, setTargetSeller] = useState('');
  const [options, setOptions] = useState<JobOptions>(DEFAULT_JOB_OPTIONS);

  // Accounts are derived from the uploads that already exist, so the list is
  // whatever has been used before plus whatever is typed next.
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.listAccounts });
  const known = accounts.data?.accounts ?? [];
  const [addingAccount, setAddingAccount] = useState(false);
  const usingNewAccount = addingAccount || known.length === 0;

  /** Clears anything derived from the previous account or file. */
  function resetReport() {
    setFilename(null);
    setReport(null);
    setOrders(null);
  }

  const validate = useMutation({
    mutationFn: ({ file, threshold, ordersReport }: { file: File; threshold: File; ordersReport: File | null }) =>
      api.validateUpload(file, threshold, targetSeller.trim(), ordersReport),
    onSuccess: (data) => {
      setFilename(data.filename);
      setReport(data.report);
      setOrders(data.orders);
      if (!name) setName(data.filename.replace(/\.(xlsx?|json)$/i, ''));
    },
  });

  const create = useMutation({
    mutationFn: () =>
      api.createJob({
        name,
        accountName: targetSeller.trim(),
        rows: report?.rows ?? [],
        options,
        orders,
      }),
    onSuccess: ({ job }) => router.push(`/jobs/${job.id}`),
  });

  return (
    <div className="w-full space-y-6 p-4 xl:p-5">
      <header>
        <h1 className="text-xl font-semibold">New batch</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick the Flipkart account, upload its spreadsheets, review what was found, then start
          scraping.
        </p>
      </header>

      <div className="space-y-2">
        <Label htmlFor="target-seller">Flipkart account</Label>

        {usingNewAccount ? (
          <div className="flex gap-2">
            <Input
              id="target-seller"
              value={targetSeller}
              onChange={(event) => {
                setTargetSeller(event.target.value);
                // Pins the field open: the accounts query can resolve mid-typing
                // on a first run, and swapping to a dropdown under the cursor
                // would throw away what was being typed.
                setAddingAccount(true);
                resetReport();
              }}
              placeholder="e.g. Anuttar"
              disabled={validate.isPending || create.isPending}
            />
            {known.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setAddingAccount(false);
                  setTargetSeller('');
                  resetReport();
                }}
                disabled={validate.isPending || create.isPending}
              >
                Cancel
              </Button>
            )}
          </div>
        ) : (
          <Select
            value={targetSeller}
            onValueChange={(value) => {
              // A sentinel rather than an empty value: Radix reserves the empty
              // string for "nothing selected".
              if (value === NEW_ACCOUNT) {
                setAddingAccount(true);
                setTargetSeller('');
              } else {
                setTargetSeller(value);
              }
              resetReport();
            }}
            disabled={validate.isPending || create.isPending}
          >
            <SelectTrigger id="target-seller">
              <SelectValue placeholder="Select an account" />
            </SelectTrigger>
            <SelectContent>
              {known.map((account) => (
                <SelectItem key={account.name} value={account.name}>
                  {account.name} — {account.uploads} upload{account.uploads === 1 ? '' : 's'}
                </SelectItem>
              ))}
              <SelectItem value={NEW_ACCOUNT}>+ New account…</SelectItem>
            </SelectContent>
          </Select>
        )}

        <p className="text-xs text-muted-foreground">
          Every row in this batch is scraped as this seller, and its recommendations only ever read
          this account&apos;s previous uploads.
        </p>
      </div>

      <UploadDropzone
        onFile={(file) => {
          setListingFile(file);
          setFilename(null);
          setReport(null);
        }}
        disabled={validate.isPending || create.isPending || !targetSeller.trim()}
        filename={listingFile?.name ?? null}
        title="Drop seller listing XLS/XLSX, or click to browse"
        description="Uses Seller SKU Id, Flipkart Serial Number and Bank Settlement"
      />

      <UploadDropzone
        onFile={(file) => {
          setThresholdFile(file);
          setReport(null);
        }}
        disabled={validate.isPending || create.isPending || !targetSeller.trim()}
        filename={thresholdFile?.name ?? null}
        title="Drop minimum settlement XLS/XLSX, or click to browse"
        description="Uses FSN and Minimum Bank Settlement price"
      />

      <UploadDropzone
        onFile={(file) => {
          setOrdersFile(file);
          setReport(null);
          setOrders(null);
        }}
        disabled={validate.isPending || create.isPending || !targetSeller.trim()}
        filename={ordersFile?.name ?? null}
        title="Optional — drop the Flipkart orders report, or click to browse"
        description="Uses FSN, order date and quantity. Without it, Buy Box rows are never re-priced."
      />

      <Button
        type="button"
        onClick={() => {
          if (!listingFile || !thresholdFile) return;
          validate.mutate({ file: listingFile, threshold: thresholdFile, ordersReport: ordersFile });
        }}
        disabled={
          validate.isPending ||
          create.isPending ||
          !targetSeller.trim() ||
          !listingFile ||
          !thresholdFile
        }
      >
        {validate.isPending ? <Loader2 className="animate-spin" /> : <Play />}
        Validate spreadsheets
      </Button>

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
        <Alert variant={orders && orders.observedDays >= 7 ? 'default' : 'warning'}>
          <AlertTitle>
            {!orders
              ? 'No orders report — Buy Box rows will not be re-priced'
              : orders.observedDays >= 7
                ? 'Orders report read'
                : 'Orders report is too short to judge a quiet day'}
          </AlertTitle>
          <AlertDescription>
            {orders ? (
              <>
                {orders.totalOrderItems.toLocaleString('en-IN')} order items covering{' '}
                {orders.fsnCount} FSN{orders.fsnCount === 1 ? '' : 's'} over{' '}
                {orders.observedDays.toFixed(1)} days, ending {formatDateTime(orders.windowEnd)}. The
                &ldquo;last 24 hours&rdquo; is measured back from that, not from now.
                {orders.observedDays < 7 && (
                  <>
                    {' '}
                    Deciding whether zero orders is unusual needs to know what usual looks like, so
                    the newest day is the test and everything before it is the baseline — download
                    the last 30 days rather than the last 24 hours. Below a week of history the Buy
                    Box rules stay conservative and will mostly leave prices alone.
                  </>
                )}
              </>
            ) : (
              <>
                Rules 11–14 need order activity to tell a Buy Box that is converting from one that is
                not. Without the report, a row we already win is left alone exactly as before.
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

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
