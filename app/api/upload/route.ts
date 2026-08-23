/**
 * POST /api/upload — validate an uploaded spreadsheet file.
 *
 * Validation only; nothing is written. The user reviews the report and then
 * POSTs to /api/jobs to actually create the batch. Splitting the two means a
 * file with 40 duplicate rows never leaves a half-made job on disk.
 */

import { NextResponse } from 'next/server';
import { validateUpload } from '@/lib/validation/uploadSchema';
import { spreadsheetToScrapeRows } from '@/lib/validation/spreadsheetUpload';

export const runtime = 'nodejs';

/** Guard against someone posting a multi-gigabyte file into memory. */
const MAX_BYTES = 25 * 1024 * 1024;

export async function POST(request: Request) {
  const contentType = request.headers.get('content-type') ?? '';
  let text: string;
  let filename = 'upload.xlsx';

  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('file');
      const targetSeller = String(form.get('targetSeller') ?? '').trim();

      if (!targetSeller) {
        return NextResponse.json({ error: 'Target seller is required.' }, { status: 400 });
      }

      // Duck-typed, not `instanceof File`: the File global only exists in Node
      // 20+, and this project supports Node 18. A form file is a Blob with a
      // name, which is all we actually use.
      if (!file || typeof file === 'string' || typeof (file as Blob).text !== 'function') {
        return NextResponse.json({ error: 'No listing file was uploaded.' }, { status: 400 });
      }

      const blob = file as Blob & { name?: string };
      if (blob.size > MAX_BYTES) {
        return NextResponse.json(
          { error: `Listing file is ${(blob.size / 1024 / 1024).toFixed(1)}MB; the limit is 25MB.` },
          { status: 413 },
        );
      }
      filename = blob.name || filename;
      const rows = spreadsheetToScrapeRows(await blob.arrayBuffer(), targetSeller);
      text = JSON.stringify(rows);
    } else {
      text = await request.text();
      if (text.length > MAX_BYTES) {
        return NextResponse.json({ error: 'Payload too large.' }, { status: 413 });
      }
    }
  } catch (error) {
    return NextResponse.json(
      { error: `Could not read the upload: ${error instanceof Error ? error.message : String(error)}` },
      { status: 400 },
    );
  }

  const report = validateUpload(text);
  return NextResponse.json({ filename, report });
}
