'use client';

import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatDateTime, formatPrice, formatSettlement, formatSignedNumber } from '@/lib/format';
import {
  BENCHMARK_STATUS_LABEL,
  RECOMMENDATION_CATEGORY_LABEL,
  RULE_LABEL,
  type Recommendation,
} from '@/lib/recommendation';
import { sellerListingUrl } from '@/lib/settlement';
import { cn } from '@/lib/utils';

/**
 * Everything behind one recommendation, on one screen.
 *
 * The point of this dialog is that a price on a list is only actionable if the
 * user can see why it is there — so the rule, the reason and the account's own
 * history for this FSN are shown alongside the figures, not summarised away.
 */

export function RecommendationDetailDialog({
  item,
  onOpenChange,
}: {
  item: Recommendation | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={item !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto scrollbar-thin">
        {item && <DetailBody item={item} />}
      </DialogContent>
    </Dialog>
  );
}

function DetailBody({ item }: { item: Recommendation }) {
  return (
    <>
      <DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <DialogTitle className="truncate">{item.sku}</DialogTitle>
          <Badge variant="secondary">{RECOMMENDATION_CATEGORY_LABEL[item.category]}</Badge>
          <Badge variant="outline" className="font-mono text-[11px] font-normal">
            {item.reasonCode}
          </Badge>
        </div>
        <DialogDescription className="tabular">
          FSN {item.fsn} · {item.accountName}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-5">
        <section className="grid gap-3 sm:grid-cols-3">
          <Figure label="Current price" value={formatPrice(item.currentPrice)} />
          <Figure label="Winner price" value={formatPrice(item.winnerPrice)} />
          <Figure
            label="Recommended price"
            value={item.recommendedPrice === null ? 'No change' : formatPrice(item.recommendedPrice)}
            tone={item.recommendedPrice === null ? 'muted' : 'success'}
            hint={item.priceDelta === null ? undefined : `${formatSignedNumber(item.priceDelta)} vs current`}
          />
        </section>

        <section className="grid gap-3 sm:grid-cols-3">
          <Figure label="Current settlement" value={formatSettlement(item.currentSettlement)} />
          <Figure label="Minimum settlement" value={formatSettlement(item.minSettlement)} />
          <Figure
            label="Projected settlement"
            value={formatSettlement(item.projectedSettlement)}
            tone={
              item.projectedSettlement === null || item.minSettlement === null
                ? 'default'
                : item.projectedSettlement >= item.minSettlement
                  ? 'success'
                  : 'failed'
            }
          />
        </section>

        <section className="grid gap-3 sm:grid-cols-3">
          <Figure
            label="Benchmark price"
            value={item.benchmarkPrice ? formatPrice(item.benchmarkPrice) : 'None published'}
            tone={item.benchmarkStatus === 'BENCHMARK_USABLE' ? 'default' : 'muted'}
            hint={BENCHMARK_STATUS_LABEL[item.benchmarkStatus]}
          />
          <Figure
            label="Minimum acceptable price"
            value={item.minAcceptablePrice === null ? 'Unprovable' : formatPrice(item.minAcceptablePrice)}
            tone={item.minAcceptablePrice === null ? 'muted' : 'default'}
            hint="The price at which the settlement hits its floor"
          />
          <Figure
            label="Buy Box status"
            value={item.hasBuybox === null ? 'Unknown' : item.hasBuybox ? 'Won' : 'Lost'}
            tone={item.hasBuybox === null ? 'muted' : item.hasBuybox ? 'success' : 'default'}
            hint={item.winningSeller ? `Winner: ${item.winningSeller}` : 'No winning seller was read'}
          />
        </section>

        <section className="grid gap-3 sm:grid-cols-2">
          <Figure
            label="Orders in the last 24h"
            value={
              item.ordersLast24h === null
                ? 'No orders report'
                : `${item.ordersLast24h} unit${item.ordersLast24h === 1 ? '' : 's'}`
            }
            tone={
              item.ordersLast24h === null ? 'muted' : item.ordersLast24h > 0 ? 'success' : 'failed'
            }
            hint={
              item.historicalUnitsPerDay === null
                ? 'Upload the Flipkart orders report to measure conversion'
                : `Normally ${item.historicalUnitsPerDay.toFixed(2)} units/day`
            }
          />
          <Figure label="Rule applied" value={RULE_LABEL[item.rule]} small />
        </section>

        {item.demand && (
          <section className="rounded-lg border bg-muted/40 p-3">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Zero-order evidence
            </h3>
            <p className="mt-1.5 text-sm">
              At {item.demand.unitsPerDay.toFixed(2)} units/day, a full day with no orders would
              happen {(item.demand.zeroProbability * 100).toFixed(1)}% of the time by chance alone.
              Across {item.demand.observedDays.toFixed(1)} days of orders that makes this a{' '}
              <span className="font-medium">{item.demand.signal}</span> signal —{' '}
              {Math.round(item.demand.confidence * 100)}% confidence.
              {item.demand.damped &&
                ' Stepped down one band because the price is already at or under the benchmark.'}
            </p>
          </section>
        )}

        <section className="rounded-lg border bg-muted/40 p-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Recommendation reason
          </h3>
          <p className="mt-1.5 text-sm">{item.reason}</p>
          {item.appliedRules.length > 1 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {item.appliedRules.map((rule) => (
                <Badge key={rule} variant="outline" className="text-[11px] font-normal">
                  {RULE_LABEL[rule]}
                </Badge>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Historical summary
          </h3>

          {item.history.uploads === 0 ? (
            <p className="text-sm text-muted-foreground">
              No previous upload for this account contained this FSN — the recommendation uses only
              this upload&apos;s data.
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Seen in {item.history.uploads} previous upload{item.history.uploads === 1 ? '' : 's'},
                winning the Buy Box {item.history.buyboxWins} time
                {item.history.buyboxWins === 1 ? '' : 's'}
                {item.history.repeatedWinningPrice !== null &&
                  ` · ${formatPrice(item.history.repeatedWinningPrice)} won ${item.history.repeatedWinningPriceCount} times`}
                {item.history.lastFiveWithoutBuybox && ' · no Buy Box in the last five uploads'}
                .
              </p>

              <div className="overflow-hidden rounded-lg border">
                <table className="w-full caption-bottom text-sm">
                  <thead className="border-b bg-muted">
                    <tr>
                      {['Upload', 'When', 'My price', 'Winner price', 'Buy Box'].map((header, index) => (
                        <th
                          key={header}
                          className={cn(
                            'h-9 px-3 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground',
                            index >= 2 && 'text-right',
                          )}
                        >
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {item.history.entries.map((entry) => (
                      <tr key={entry.jobId} className="border-b last:border-0">
                        <td className="max-w-[12rem] truncate px-3 py-1.5" title={entry.jobName}>
                          {entry.jobName}
                        </td>
                        <td className="tabular px-3 py-1.5 text-xs text-muted-foreground">
                          {formatDateTime(entry.uploadTime)}
                        </td>
                        <td className="tabular px-3 py-1.5 text-right">{formatPrice(entry.myPrice)}</td>
                        <td className="tabular px-3 py-1.5 text-right">{formatPrice(entry.winnerPrice)}</td>
                        <td className="px-3 py-1.5 text-right">
                          {entry.hasBuybox === null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : entry.hasBuybox ? (
                            <span className="font-medium text-status-success">Won</span>
                          ) : (
                            <span className="text-muted-foreground">Lost</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        <div className="flex justify-end">
          <Button variant="outline" size="sm" asChild>
            <a href={sellerListingUrl(item.fsn)} target="_blank" rel="noopener noreferrer">
              <ExternalLink /> Open in Seller Hub
            </a>
          </Button>
        </div>
      </div>
    </>
  );
}

const TONES = {
  default: 'text-foreground',
  muted: 'text-muted-foreground',
  success: 'text-status-success',
  failed: 'text-status-failed',
} as const;

function Figure({
  label,
  value,
  hint,
  tone = 'default',
  small,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: keyof typeof TONES;
  small?: boolean;
}) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('tabular mt-1 font-semibold', small ? 'text-sm leading-snug' : 'text-lg', TONES[tone])}>
        {value}
      </p>
      {hint && <p className="mt-1 truncate text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
