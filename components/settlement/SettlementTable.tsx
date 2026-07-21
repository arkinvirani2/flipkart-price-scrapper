'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import { sellerListingUrl, type Settlement } from '@/lib/settlement';
import { cn } from '@/lib/utils';
import type { JobRow } from '@/types/dashboard';

/**
 * A virtualized settlement list.
 *
 * Same virtualization strategy as the queue table — only the visible slice is in
 * the DOM — generalized over a column set so the main, below-threshold and
 * review lists all share one implementation. The many columns are wider than a
 * half-width panel, so the whole grid scrolls horizontally as one unit (header
 * and rows share the same track template and min width).
 *
 * Every row is a link to the product's Flipkart Seller Hub listing, opened in a
 * new tab.
 */

const ROW_HEIGHT = 40;
const OVERSCAN = 12;

export interface SettlementRow {
  row: JobRow;
  settlement: Settlement;
}

export interface SettlementColumn {
  key: string;
  header: string;
  /** Track width in rem. Summed to give the grid its horizontal-scroll min width. */
  width: number;
  align?: 'left' | 'right';
  cell: (entry: SettlementRow) => React.ReactNode;
}

interface Props {
  rows: SettlementRow[];
  columns: SettlementColumn[];
  emptyMessage: string;
}

export function SettlementTable({ rows, columns, emptyMessage }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  const template = columns.map((column) => `${column.width}rem`).join(' ');
  const minWidth = `${columns.reduce((sum, column) => sum + column.width, 0)}rem`;
  const items = virtualizer.getVirtualItems();

  const open = (fsn: string) => window.open(sellerListingUrl(fsn), '_blank', 'noopener,noreferrer');

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="overflow-x-auto scrollbar-thin">
        <div style={{ minWidth }}>
          <div
            className="grid items-center gap-2 border-b bg-muted/40 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
            style={{ gridTemplateColumns: template }}
          >
            {columns.map((column) => (
              <span key={column.key} className={cn('truncate', column.align === 'right' && 'text-right')}>
                {column.header}
              </span>
            ))}
          </div>

          {rows.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">{emptyMessage}</p>
          ) : (
            <div ref={parentRef} className="max-h-[28rem] overflow-y-auto scrollbar-thin">
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {items.map((item) => {
                  const entry = rows[item.index];
                  return (
                    <div
                      key={entry.row.key}
                      role="button"
                      tabIndex={0}
                      className="absolute left-0 top-0 grid w-full cursor-pointer items-center gap-2 border-b px-3 text-sm outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/60"
                      style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)`, gridTemplateColumns: template }}
                      onClick={() => open(entry.row.fsn)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          open(entry.row.fsn);
                        }
                      }}
                      title={`Open listing ${entry.row.fsn} in Flipkart Seller Hub`}
                    >
                      {columns.map((column) => (
                        <span
                          key={column.key}
                          className={cn('truncate', column.align === 'right' && 'text-right tabular')}
                        >
                          {column.cell(entry)}
                        </span>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
