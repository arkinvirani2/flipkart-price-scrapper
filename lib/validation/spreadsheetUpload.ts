import * as XLSX from 'xlsx';
import type { ScrapeInput } from '@/scraper/types';

const PRODUCT_URL_PREFIX = 'https://www.flipkart.com/product/p/itme?pid=';

type NumericInputField =
  | 'currentBankSettlement'
  | 'bankSettlementThreshold'
  | 'benchmarkPrice'
  | 'stockCount';

type SpreadsheetScrapeInput = Omit<ScrapeInput, NumericInputField> & Record<NumericInputField, string>;

const FIELD_HEADERS = {
  sku: ['seller sku id', 'seller sku'],
  fsn: ['flipkart serial number', 'fsn'],
  currentBankSettlement: ['bank settlement'],
  // Flipkart's own competitive price read, and the stock behind the listing.
  // Both are optional: an older export without them still uploads, and the
  // rules that read them simply do not fire.
  benchmarkPrice: ['benchmark price'],
  stockCount: ['system stock count', 'your stock count'],
} as const;

const THRESHOLD_HEADERS = {
  fsn: ['flipkart serial number', 'fsn'],
  bankSettlementThreshold: ['minimum bank settlement price'],
} as const;

export function spreadsheetToScrapeRows(
  buffer: ArrayBuffer,
  targetSeller: string,
  thresholdByFsn: Map<string, string>,
): SpreadsheetScrapeInput[] {
  const workbook = XLSX.read(Buffer.from(buffer), { type: 'buffer' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];

  const sheet = workbook.Sheets[firstSheetName];
  const table = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false });
  const headerIndex = findHeaderRow(table);
  if (headerIndex === -1) return [];

  const columns = mapColumns(table[headerIndex]);
  let dataStart = headerIndex + 1;
  if (looksLikeInstructionRow(table[dataStart], columns)) dataStart += 1;

  return table
    .slice(dataStart)
    .map((row) => toScrapeInput(row, columns, targetSeller, thresholdByFsn))
    .filter((row): row is SpreadsheetScrapeInput => row !== null);
}

export function minimumSettlementByFsn(buffer: ArrayBuffer): Map<string, string> {
  const workbook = XLSX.read(Buffer.from(buffer), { type: 'buffer' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return new Map();

  const sheet = workbook.Sheets[firstSheetName];
  const table = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false });
  const headerIndex = findMinimumSettlementHeaderRow(table);
  if (headerIndex === -1) return new Map();

  const columns = {
    fsn: findColumn(table[headerIndex], THRESHOLD_HEADERS.fsn),
    bankSettlementThreshold: findColumn(table[headerIndex], THRESHOLD_HEADERS.bankSettlementThreshold),
  };

  const values = new Map<string, string>();
  for (const row of table.slice(headerIndex + 1)) {
    const fsn = cellText(row[columns.fsn]);
    const threshold = cellText(row[columns.bankSettlementThreshold]);
    if (fsn && threshold) values.set(fsn, threshold);
  }

  return values;
}

function findHeaderRow(table: unknown[][]): number {
  return table.findIndex((row) => {
    const normalized = row.map((cell) => normalizeHeader(cell));
    return (
      hasAny(normalized, FIELD_HEADERS.sku) &&
      hasAny(normalized, FIELD_HEADERS.fsn) &&
      hasAny(normalized, FIELD_HEADERS.currentBankSettlement)
    );
  });
}

function findMinimumSettlementHeaderRow(table: unknown[][]): number {
  return table.findIndex((row) => {
    const normalized = row.map((cell) => normalizeHeader(cell));
    return (
      hasAny(normalized, THRESHOLD_HEADERS.fsn) &&
      hasAny(normalized, THRESHOLD_HEADERS.bankSettlementThreshold)
    );
  });
}

function mapColumns(headerRow: unknown[]): Record<keyof typeof FIELD_HEADERS, number> {
  return {
    sku: findColumn(headerRow, FIELD_HEADERS.sku),
    fsn: findColumn(headerRow, FIELD_HEADERS.fsn),
    currentBankSettlement: findColumn(headerRow, FIELD_HEADERS.currentBankSettlement),
    benchmarkPrice: findColumn(headerRow, FIELD_HEADERS.benchmarkPrice),
    stockCount: findColumn(headerRow, FIELD_HEADERS.stockCount),
  };
}

function findColumn(headerRow: unknown[], names: readonly string[]): number {
  return headerRow.findIndex((cell) => names.includes(normalizeHeader(cell)));
}

function hasAny(values: string[], names: readonly string[]): boolean {
  return values.some((value) => names.includes(value));
}

function looksLikeInstructionRow(
  row: unknown[] | undefined,
  columns: Record<keyof typeof FIELD_HEADERS, number>,
): boolean {
  if (!row) return false;

  const sku = cellText(row[columns.sku]).toLowerCase();
  const fsn = cellText(row[columns.fsn]).toLowerCase();

  return sku.includes('identifier for a product') || fsn.includes('identifier of the product');
}

function toScrapeInput(
  row: unknown[],
  columns: Record<keyof typeof FIELD_HEADERS, number>,
  targetSeller: string,
  thresholdByFsn: Map<string, string>,
): SpreadsheetScrapeInput | null {
  const sku = cellText(row[columns.sku]);
  const fsn = cellText(row[columns.fsn]);

  if (!sku && !fsn) return null;

  return {
    productUrl: `${PRODUCT_URL_PREFIX}${encodeURIComponent(fsn)}`,
    targetSeller,
    sku,
    fsn,
    currentBankSettlement: cellText(row[columns.currentBankSettlement]),
    bankSettlementThreshold: thresholdByFsn.get(fsn) ?? '',
    // findColumn returns -1 for a sheet that has no such column, and row[-1] is
    // undefined, which cellText turns into '' — i.e. "not supplied", which is
    // exactly how the validator treats an absent optional number.
    benchmarkPrice: cellText(row[columns.benchmarkPrice]),
    stockCount: cellText(row[columns.stockCount]),
  };
}

function normalizeHeader(value: unknown): string {
  return cellText(value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function cellText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}
