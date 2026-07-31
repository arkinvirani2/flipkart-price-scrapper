/**
 * On-disk layout for dashboard data.
 *
 *   data/jobs/<jobId>/job.json         manifest
 *   data/jobs/<jobId>/inputs.json      the uploaded file, verbatim
 *   data/jobs/<jobId>/results.ndjson   the scraper's own journal format
 *   data/jobs/<jobId>/logs.ndjson      log lines
 *   data/jobs/<jobId>/screenshots/     failure screenshots
 *   data/jobs/<jobId>/recommendations.json  the saved pricing recommendations
 *
 * Everything is under one directory so a job can be zipped, copied or deleted
 * as a unit, and so `results.ndjson` remains a file the CLI could resume from.
 */

import { mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** Job ids are used as path segments, so the character set is deliberately narrow. */
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function dataDir(): string {
  return process.env.SCRAPER_DATA_DIR
    ? resolve(process.env.SCRAPER_DATA_DIR)
    : join(process.cwd(), 'data');
}

export function jobsDir(): string {
  return join(dataDir(), 'jobs');
}

/**
 * Reject anything that is not a plain job id.
 *
 * Job ids arrive from route params, which means they are user input: without
 * this, `../../` in a URL would read and write arbitrary files.
 */
export function assertJobId(jobId: string): string {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error(`Invalid job id: ${JSON.stringify(jobId)}`);
  }
  return jobId;
}

export function jobDir(jobId: string): string {
  return join(jobsDir(), assertJobId(jobId));
}

export const jobPaths = {
  manifest: (jobId: string) => join(jobDir(jobId), 'job.json'),
  inputs: (jobId: string) => join(jobDir(jobId), 'inputs.json'),
  journal: (jobId: string) => join(jobDir(jobId), 'results.ndjson'),
  logs: (jobId: string) => join(jobDir(jobId), 'logs.ndjson'),
  screenshots: (jobId: string) => join(jobDir(jobId), 'screenshots'),
  // Written once, when a run ends. Viewing an old upload reads this file rather
  // than re-deciding anything, so history never changes under the user.
  recommendations: (jobId: string) => join(jobDir(jobId), 'recommendations.json'),
};

export function ensureJobDir(jobId: string): string {
  const dir = jobDir(jobId);
  mkdirSync(join(dir, 'screenshots'), { recursive: true });
  return dir;
}

export function ensureDataDir(): void {
  mkdirSync(jobsDir(), { recursive: true });
}

/**
 * Resolve a path that must stay inside the data directory.
 *
 * Screenshot paths are stored in the journal and later served over HTTP; this
 * is the gate that stops a doctored journal from turning into arbitrary file
 * reads.
 */
export function resolveWithinData(candidate: string): string | null {
  const root = dataDir();
  const full = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const rel = relative(root, full);

  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return full;
}

/**
 * A sortable, collision-resistant job id.
 *
 * Time-prefixed so a directory listing is chronological, with a random suffix
 * because two uploads in the same millisecond are entirely possible.
 */
export function newJobId(): string {
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `job_${stamp}_${random}`;
}
