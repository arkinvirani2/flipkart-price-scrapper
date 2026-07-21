/**
 * Upload validation.
 *
 * Everything is reported at once, per row, rather than throwing on the first
 * problem: a user with a 900-row file needs the whole list, not a fix-one-rerun
 * loop. Errors block the job; warnings do not.
 */

import { z } from 'zod';
import { resultKey } from '@/scraper/journal';
import type { ScrapeInput } from '@/scraper/types';

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: IssueSeverity;
  /** 1-based row number, or null for a problem with the file as a whole. */
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

const NON_EMPTY = (field: string) =>
  z
    .string({ required_error: `${field} is required`, invalid_type_error: `${field} must be a string` })
    .trim()
    .min(1, `${field} must not be empty`);

const rowSchema = z.object({
  productUrl: NON_EMPTY('productUrl'),
  targetSeller: NON_EMPTY('targetSeller'),
  sku: NON_EMPTY('sku'),
  fsn: NON_EMPTY('fsn'),
});

/** Parse raw text into rows, collecting every problem found along the way. */
export function validateUpload(text: string): ValidationReport {
  const issues: ValidationIssue[] = [];
  const rows: ScrapeInput[] = [];

  // Strip a UTF-8 BOM and surrounding whitespace before parsing. Windows editors
  // routinely prepend a BOM, and JSON.parse rejects it as an unexpected token.
  const cleaned = text.replace(/^﻿/, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    return report(
      [
        {
          severity: 'error',
          row: null,
          code: 'INVALID_JSON',
          message: `The file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      [],
      0,
    );
  }

  if (!Array.isArray(parsed)) {
    return report(
      [
        {
          severity: 'error',
          row: null,
          code: 'NOT_AN_ARRAY',
          message: 'The file must contain a JSON array of products.',
        },
      ],
      [],
      0,
    );
  }

  if (parsed.length === 0) {
    return report(
      [{ severity: 'error', row: null, code: 'EMPTY', message: 'The file contains no products.' }],
      [],
      0,
    );
  }

  const seen = new Map<string, number>();

  parsed.forEach((raw, index) => {
    const rowNumber = index + 1;

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      issues.push({
        severity: 'error',
        row: rowNumber,
        code: 'NOT_AN_OBJECT',
        message: 'Each entry must be an object.',
      });
      return;
    }

    const record = raw as Record<string, unknown>;

    // The scraper's field is `fsn`. Naming it explicitly beats a generic
    // "required" error for the one mistake people actually make here.
    if (record.fsn === undefined && record.skn !== undefined) {
      issues.push({
        severity: 'error',
        row: rowNumber,
        field: 'fsn',
        code: 'SKN_NOT_FSN',
        message: 'Found "skn" — this scraper expects "fsn" (Flipkart Serial Number). Rename the field.',
      });
      return;
    }

    const result = rowSchema.safeParse(record);
    if (!result.success) {
      for (const problem of result.error.issues) {
        issues.push({
          severity: 'error',
          row: rowNumber,
          field: String(problem.path[0] ?? ''),
          code: 'FIELD_INVALID',
          message: problem.message,
        });
      }
      return;
    }

    const row = result.data;

    const urlIssue = checkUrl(row.productUrl, rowNumber);
    if (urlIssue) {
      issues.push(urlIssue);
      if (urlIssue.severity === 'error') return;
    }

    // Duplicate identity is a correctness problem, not a style one: two rows
    // with the same key collapse to a single journal entry, so the second would
    // silently never be scraped.
    const key = resultKey(row);
    const firstSeen = seen.get(key);
    if (firstSeen !== undefined) {
      issues.push({
        severity: 'error',
        row: rowNumber,
        code: 'DUPLICATE',
        message: `Duplicate of row ${firstSeen}: same sku and productUrl. Remove one, or give them distinct SKUs.`,
      });
      return;
    }
    seen.set(key, rowNumber);

    rows.push(row);
  });

  return report(issues, rows, parsed.length);
}

function checkUrl(value: string, row: number): ValidationIssue | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      severity: 'error',
      row,
      field: 'productUrl',
      code: 'INVALID_URL',
      message: `"${truncate(value)}" is not a valid URL.`,
    };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      severity: 'error',
      row,
      field: 'productUrl',
      code: 'INVALID_URL_SCHEME',
      message: `URL must be http or https, got "${url.protocol}".`,
    };
  }

  // Short links (dl.flipkart.com) are normal and resolve fine, so anything on a
  // flipkart host passes. Anything else is probably a mistake — but it is the
  // user's call, so it only warns.
  if (!/(^|\.)flipkart\.com$/i.test(url.hostname)) {
    return {
      severity: 'warning',
      row,
      field: 'productUrl',
      code: 'NON_FLIPKART_HOST',
      message: `"${url.hostname}" is not a Flipkart domain — this row will very likely fail.`,
    };
  }

  return null;
}

function truncate(value: string, max = 60): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function report(issues: ValidationIssue[], rows: ScrapeInput[], total: number): ValidationReport {
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  return {
    ok: errorCount === 0 && rows.length > 0,
    total,
    rows,
    issues,
    errorCount,
    warningCount: issues.length - errorCount,
  };
}
