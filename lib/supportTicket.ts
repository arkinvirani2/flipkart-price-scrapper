/**
 * The Flipkart support-ticket message for products that never showed up.
 *
 * Pure and dependency-free, like `lib/settlement.ts` and `lib/demand.ts`, so the
 * wording can be asserted in a test rather than only eyeballed in the browser —
 * and so the component that renders it stays a component.
 */

/**
 * Build the ticket text from the rows the Needs-review tab is showing.
 *
 * Duplicate FSNs are collapsed (the same product can occupy more than one row)
 * and blanks are dropped, but the order the tab displays is preserved so the
 * message reads in the same order as the table above it.
 */
export function buildSupportMessage(items: Array<{ fsn: string }>): string {
  const seen = new Set<string>();
  const fsns: string[] = [];

  for (const item of items) {
    const fsn = item.fsn?.trim();
    if (!fsn || seen.has(fsn)) continue;
    seen.add(fsn);
    fsns.push(fsn);
  }

  return [
    'The following products/FSNs are not visible in the Flipkart seller panel.',
    '',
    'Please investigate why these products are not appearing in the panel and confirm whether there is any issue with their listings or account visibility.',
    '',
    `FSN List (${fsns.length}):`,
    ...fsns,
  ].join('\n');
}
