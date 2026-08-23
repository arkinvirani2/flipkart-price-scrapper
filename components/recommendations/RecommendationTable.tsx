'use client';

import type { Recommendation } from '@/lib/recommendation';

export function RecommendationTable({ rows }: { rows: Recommendation[] }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted">
            <tr>
              <th className="h-10 px-3 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground">FSN</th>
              <th className="h-10 px-3 text-right text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Diff Amount</th>
              <th className="h-10 px-3 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <tr key={item.key} className="border-b last:border-0">
                <td className="px-3 py-2 tabular">{item.fsn}</td>
                <td className="px-3 py-2 text-right tabular">{item.diffAmount ?? ''}</td>
                <td className="px-3 py-2">{item.status ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
