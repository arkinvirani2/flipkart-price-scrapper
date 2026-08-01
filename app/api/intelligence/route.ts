/**
 * GET /api/intelligence?account=Previx
 *   → the per-FSN leaderboard: top rule, accuracy, average error, times used.
 *
 * GET /api/intelligence?account=Previx&fsn=ABC123
 *   → one FSN in full: ranking, formulas, and the accuracy chart series.
 *
 * GET /api/intelligence?account=Previx&view=formulas
 *   → the formula repository, one row per generated formula.
 *
 * POST /api/intelligence  { account }
 *   → drop the account's learning and replay it from the job folders.
 */

import { NextResponse } from 'next/server';
import { deriveMetrics, emptyStats } from '@/lib/intelligence/metrics';
import { labelFor } from '@/lib/intelligence/predictors';
import { allRecords, readRecord, resetAccount, syncAccount } from '@/lib/intelligence/store';
import { DEFAULT_INTELLIGENCE_CONFIG, type FsnIntelligence } from '@/lib/intelligence/types';
import { ensureRecovered } from '@/lib/services/recovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const config = DEFAULT_INTELLIGENCE_CONFIG;

/** The row the leaderboard shows — the "output per FSN" of the specification. */
function summarize(record: FsnIntelligence) {
  const top = record.ranking[0] ?? null;
  const activeFormula = record.formulas.find((formula) => formula.status === 'active');

  return {
    fsn: record.fsn,
    topRule: top?.label ?? null,
    topRuleId: top?.id ?? null,
    accuracyPct: top?.accuracyPct ?? null,
    averageError: top?.mae ?? null,
    timesUsed: top?.timesSelected ?? 0,
    lastUsedAt: top?.lastUsedAt ?? null,
    generatedFormula: activeFormula?.expression ?? null,
    reason: top?.reason ?? 'No scored predictions yet.',
    secondBest: record.ranking[1]?.label ?? null,
    thirdBest: record.ranking[2]?.label ?? null,
    observations: record.observations.length,
    scoredPredictions: top?.n ?? 0,
    champion: record.champion,
    updatedAt: record.updatedAt,
  };
}

export async function GET(request: Request) {
  ensureRecovered();

  const url = new URL(request.url);
  const account = url.searchParams.get('account')?.trim();
  if (!account) return NextResponse.json({ error: 'account is required.' }, { status: 400 });

  // Cheap when there is nothing new — it only replays jobs it has not folded in.
  syncAccount(account, config);

  const fsn = url.searchParams.get('fsn')?.trim();

  if (fsn) {
    const record = readRecord(account, fsn);
    if (!record) return NextResponse.json({ error: 'No intelligence for that FSN.' }, { status: 404 });

    return NextResponse.json({
      fsn: record.fsn,
      accountName: record.accountName,
      champion: record.champion,
      summary: summarize(record),
      // Every predictor with a track record, not just the podium — the whole
      // point is being able to see what the bench is doing.
      predictors: Object.values(record.stats)
        .map((stats) => ({
          ...deriveMetrics(stats, config),
          label: labelFor(stats.id, record.formulas),
          kind: stats.id.startsWith('fit:') ? 'formula' : 'rule',
        }))
        .sort((left, right) => right.score - left.score),
      ranking: record.ranking,
      formulas: record.formulas,
      observations: record.observations,
      /** Historical performance graph data: one point per scored upload. */
      performance: record.performance,
      pending: record.pending,
    });
  }

  const records = allRecords(account);

  if (url.searchParams.get('view') === 'formulas') {
    const repository = records.flatMap((record) =>
      record.formulas.map((formula) => {
        const metrics = deriveMetrics(record.stats[formula.id] ?? emptyStats(formula.id), config);
        return {
          fsn: record.fsn,
          ruleName: formula.id,
          kind: formula.kind,
          formula: formula.expression,
          createdDate: formula.createdAt,
          lastUpdated: formula.updatedAt,
          accuracyPct: metrics.accuracyPct,
          validationMae: formula.validationMae,
          executionCount: metrics.n,
          averageError: metrics.mae,
          status: formula.status,
        };
      }),
    );

    return NextResponse.json({ account, total: repository.length, formulas: repository });
  }

  const limit = Math.min(Number(url.searchParams.get('limit') ?? 500) || 500, 5_000);
  const rows = records
    .map(summarize)
    .sort((left, right) => (right.accuracyPct ?? -1) - (left.accuracyPct ?? -1))
    .slice(0, limit);

  return NextResponse.json({ account, total: records.length, rows });
}

export async function POST(request: Request) {
  let body: { account?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const account = body.account?.trim();
  if (!account) return NextResponse.json({ error: 'account is required.' }, { status: 400 });

  resetAccount(account);
  const { store } = syncAccount(account, config);

  return NextResponse.json({ rebuilt: true, account, jobs: store.manifest.processedJobIds.length });
}
