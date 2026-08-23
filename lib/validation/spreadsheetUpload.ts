import * as XLSX from 'xlsx';
import type { ScrapeInput } from '@/scraper/types';

/** Read the account product table: Flipkart Link, FSN, Lowest Listing File. */
export function spreadsheetToScrapeRows(buffer: ArrayBuffer, targetSeller: string): ScrapeInput[] {
  const workbook = XLSX.read(Buffer.from(buffer), { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ''];
  if (!sheet) return [];
  const table = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false });
  const headerIndex = table.findIndex((row) => {
    const headers = row.map(normalize);
    return headers.includes('flipkart link') && headers.includes('fsn') && headers.includes('lowest listing file');
  });
  if (headerIndex < 0) return [];
  const headers = table[headerIndex].map(normalize);
  const link = headers.indexOf('flipkart link');
  const fsn = headers.indexOf('fsn');
  const lowest = headers.indexOf('lowest listing file');
  return table.slice(headerIndex + 1).flatMap((row) => {
    const productUrl = String(row[link] ?? '').trim();
    const fsnValue = String(row[fsn] ?? '').trim();
    const lowestListingFile = String(row[lowest] ?? '').trim();
    if (!productUrl && !fsnValue && !lowestListingFile) return [];
    return [{ productUrl, targetSeller, fsn: fsnValue, sku: fsnValue, lowestListingFile: Number(lowestListingFile) }];
  });
}

function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}
