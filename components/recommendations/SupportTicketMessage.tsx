'use client';

/**
 * The Needs-review tab's copyable Flipkart support message.
 *
 * A Needs-review row is one the run could not price — the product page did not
 * load, our seller was not on it, or the scrape failed outright. Individually
 * those are a nuisance; together they are a support ticket, and the only thing
 * standing between the user and raising one is retyping thirty FSNs by hand.
 *
 * The list is generated from whatever is actually in the tab, so it can never
 * drift from what the user is looking at.
 */

import { useState } from 'react';
import { Check, Copy, LifeBuoy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Recommendation } from '@/lib/recommendation';
import { buildSupportMessage } from '@/lib/supportTicket';

interface Props {
  items: Recommendation[];
}

export function SupportTicketMessage({ items }: Props) {
  const [copied, setCopied] = useState(false);
  const message = buildSupportMessage(items);

  // Nothing to raise a ticket about.
  if (items.length === 0) return null;

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (insecure context, denied permission).
      // The textarea below is selectable, so the user still has a way through —
      // failing silently here is better than an error over a working fallback.
    }
  };

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <LifeBuoy className="size-4" />
          Flipkart support message
          <span className="text-xs font-normal text-muted-foreground">
            {items.length} product{items.length === 1 ? '' : 's'} not visible in the panel
          </span>
        </div>
        <Button size="sm" variant="outline" onClick={copy}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? 'Copied' : 'Copy message'}
        </Button>
      </div>

      {/* Read-only rather than disabled: a disabled textarea cannot be selected,
          which would remove the fallback for a blocked clipboard. */}
      <textarea
        readOnly
        value={message}
        rows={10}
        className="w-full resize-y rounded-md border bg-background p-2 font-mono text-xs"
        onFocus={(event) => event.currentTarget.select()}
      />
    </div>
  );
}
