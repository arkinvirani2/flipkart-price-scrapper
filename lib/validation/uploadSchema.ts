import { resultKey } from '@/scraper/journal';
import type { ScrapeInput } from '@/scraper/types';

export interface ValidationIssue {
  severity: 'error';
  row: number | null;
  field?: string;
  code: string;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  total: number;
  rows: ScrapeInput[];
  issues: ValidationIssue[];
  errorCount: number;
  warningCount: number;
}

export function validateUpload(text: string): ValidationReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, '').trim());
  } catch {
    return report([], [{ severity: 'error', row: null, code: 'INVALID_JSON', message: 'The file is not valid JSON.' }], 0);
  }
  if (!Array.isArray(parsed)) return report([], [{ severity: 'error', row: null, code: 'NOT_AN_ARRAY', message: 'The file must contain a JSON array of products.' }], 0);

  const rows: ScrapeInput[] = [];
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  parsed.forEach((value, index) => {
    const row = index + 1;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      issues.push({ severity: 'error', row, code: 'NOT_AN_OBJECT', message: 'Each product must be an object.' });
      return;
    }
    const input = value as Record<string, unknown>;
    const productUrl = typeof input.productUrl === 'string' ? input.productUrl.trim() : '';
    const targetSeller = typeof input.targetSeller === 'string' ? input.targetSeller.trim() : '';
    const fsn = typeof input.fsn === 'string' ? input.fsn.trim() : '';
    const rawLowest = input.lowestListingFile;
    const lowestListingFile = typeof rawLowest === 'number' ? rawLowest : typeof rawLowest === 'string' ? Number(rawLowest.trim()) : Number.NaN;
    if (!productUrl || !targetSeller || !fsn || !Number.isFinite(lowestListingFile)) {
      issues.push({ severity: 'error', row, code: 'FIELD_INVALID', message: 'Flipkart Link, FSN, Lowest Listing File, and account are required.' });
      return;
    }
    const item: ScrapeInput = { productUrl, targetSeller, fsn, sku: fsn, lowestListingFile };
    const key = resultKey(item);
    if (seen.has(key)) {
      issues.push({ severity: 'error', row, code: 'DUPLICATE', message: 'Duplicate Flipkart Link and FSN.' });
      return;
    }
    seen.add(key);
    rows.push(item);
  });
  return report(rows, issues, parsed.length);
}

function report(rows: ScrapeInput[], issues: ValidationIssue[], total: number): ValidationReport {
  return { ok: issues.length === 0 && rows.length > 0, total, rows, issues, errorCount: issues.length, warningCount: 0 };
}
