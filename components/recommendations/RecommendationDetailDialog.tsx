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
import { formatPrice, formatSettlement, formatSignedNumber } from '@/lib/format';
import { RECOMMENDATION_CATEGORY_LABEL, type Recommendation } from '@/lib/recommendation';
import { sellerListingUrl } from '@/lib/settlement';
import { cn } from '@/lib/utils';

/**
 * One record's figures, on one screen.
 *
 * Every value shown here is one of the figures the tabs are defined on — the
 * three sheets' inputs and the three subtractions derived from them. Nothing is
 * summarised or explained away, because there is nothing behind them to explain:
 * the tab a record sits in is the first filter it passed.
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
          <Badge variant="secondary">
            {item.category === null ? 'No tab' : RECOMMENDATION_CATEGORY_LABEL[item.category]}
          </Badge>
        </div>
        <DialogDescription className="tabular">
          FSN {item.fsn} · {item.seller}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-5">
        {/* Sheet 1 and the scrape, side by side: the listing price is what the
            seller edits, the displayed price is what a buyer actually sees. */}
        <section className="grid gap-3 sm:grid-cols-3">
          <Figure
            label="Current listing price"
            value={formatPrice(item.listingPrice)}
            hint="Your listing price, from the listing sheet"
          />
          <Figure
            label="Flipkart display our price"
            value={formatPrice(item.flipkartDisplayPrice)}
            hint="What Flipkart shows a buyer for our listing"
          />
          <Figure
            label="Winner price"
            value={formatPrice(item.winnerPrice)}
            hint={item.winnerSeller ? `Winner seller: ${item.winnerSeller}` : 'No winner seller was read'}
          />
        </section>

        <section className="grid gap-3 sm:grid-cols-3">
          <Figure
            label="Change"
            value={formatSignedNumber(item.difference)}
            hint="Winner price − Flipkart display our price"
          />
          <Figure
            label="Benchmark difference"
            value={formatSignedNumber(item.benchmarkDifference)}
            hint="Benchmark price − Flipkart display our price"
          />
          <Figure
            label="Benchmark price"
            value={formatPrice(item.benchmarkPrice)}
            hint="From the listing sheet"
          />
        </section>

        <section className="grid gap-3 sm:grid-cols-3">
          <Figure
            label="Current bank settlement"
            value={formatSettlement(item.currentSettlement)}
            hint="From the listing sheet"
          />
          <Figure
            label="Minimum bank settlement"
            value={formatSettlement(item.minSettlement)}
            hint="From the settlement sheet"
          />
          <Figure
            label="Fees"
            value={formatSettlement(item.fees)}
            hint="Your listing price − current bank settlement"
          />
        </section>

        <section className="grid gap-3 sm:grid-cols-3">
          <Figure
            label="Expected listing price"
            value={item.expectedListingPrice === null ? '—' : formatPrice(item.expectedListingPrice)}
            tone={item.expectedListingPrice === null ? 'muted' : 'success'}
            hint={item.expectedListingPrice === null ? 'This tab defines no expected price' : undefined}
          />
          <Figure
            label="Expected bank settlement"
            value={
              item.expectedBankSettlement === null ? '—' : formatSettlement(item.expectedBankSettlement)
            }
            tone={item.expectedBankSettlement === null ? 'muted' : 'success'}
            hint={
              item.expectedBankSettlement === null ? 'This tab defines no expected settlement' : undefined
            }
          />
          <Figure
            label="Buy Box won"
            value={item.hasBuybox === null ? 'Unknown' : item.hasBuybox ? 'Yes' : 'No'}
            tone={item.hasBuybox === null ? 'muted' : item.hasBuybox ? 'success' : 'default'}
            hint={item.winnerSeller ? `Winner seller: ${item.winnerSeller}` : 'No winner seller was read'}
          />
        </section>

        <section className="grid gap-3 sm:grid-cols-3">
          <Figure
            label="Orders count (last 24h)"
            value={
              item.orderCount === null
                ? 'No orders report'
                : `${item.orderCount} unit${item.orderCount === 1 ? '' : 's'}`
            }
            tone={item.orderCount === null ? 'muted' : item.orderCount > 0 ? 'success' : 'failed'}
            hint="From the orders sheet"
          />
          <Figure
            label="Sellers in this listing"
            value={item.sellerCount === null ? 'Unknown' : String(item.sellerCount)}
            tone={item.sellerCount === null ? 'muted' : 'default'}
            hint="Counted by the scrape, ours included"
          />
          <Figure
            label="Scrape status"
            value={item.scrapeStatus ?? 'Not scraped'}
            tone={item.scrapeFailed ? 'failed' : 'success'}
            hint={item.scrapeMessage ?? undefined}
            small
          />
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
