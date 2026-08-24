import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildRecommendation, type Recommendation } from '@/lib/recommendation';
import { getJob, updateManifest } from '@/lib/store/jobStore';
import { jobPaths } from '@/lib/store/paths';

// 4: diffAmount flipped to the settlement direction (mainPrice − sellerPrice),
// plus the Threshold Missing / Need Review statuses and their reason. Bumping
// this discards recommendation files written by the old, wrongly-signed maths.
export const RECOMMENDATION_SCHEMA = 4;

export interface RecommendationFile {
  schema: number;
  jobId: string;
  jobName: string;
  accountName: string;
  generatedAt: string;
  summary: string;
  recommendations: Recommendation[];
}

export function generateRecommendations(jobId: string): RecommendationFile | null {
  const record = getJob(jobId);
  if (!record) return null;

  const recommendations = record.rows.map(buildRecommendation);
  const generatedAt = new Date().toISOString();
  const file: RecommendationFile = {
    schema: RECOMMENDATION_SCHEMA,
    jobId,
    jobName: record.manifest.name,
    accountName: record.manifest.accountName ?? '',
    generatedAt,
    summary: `${recommendations.length} FSNs`,
    recommendations,
  };
  writeFileSync(jobPaths.recommendations(jobId), JSON.stringify(file, null, 2), 'utf8');
  updateManifest(jobId, { recommendationSummary: file.summary, recommendationsGeneratedAt: generatedAt });
  return file;
}

export function loadRecommendations(jobId: string): RecommendationFile | null {
  const path = jobPaths.recommendations(jobId);
  if (!existsSync(path)) return null;
  try {
    const file = JSON.parse(readFileSync(path, 'utf8')) as RecommendationFile;
    return file.schema === RECOMMENDATION_SCHEMA ? file : null;
  } catch {
    return null;
  }
}

export function ensureRecommendations(jobId: string): RecommendationFile | null {
  return loadRecommendations(jobId) ?? generateRecommendations(jobId);
}
