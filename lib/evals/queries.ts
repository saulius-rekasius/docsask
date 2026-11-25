import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { evalQuestions, evalResults, evalRuns } from "../db/schema";

/** Read side of the eval tables, for the /evals pages. */

export interface MetricSummary {
  n: number;
  recallAt5: number | null;
  recallAt10: number | null;
  mrr: number | null;
  ndcgAt5: number | null;
  hitAt1: number | null;
}

export interface RunSummary {
  overall: MetricSummary;
  byCategory: Record<string, MetricSummary>;
  latencyMs: { p50: number; p95: number };
  n: number;
}

export interface RunRow {
  id: string;
  configName: string;
  split: "dev" | "holdout" | null;
  gitSha: string | null;
  createdAt: Date;
  summary: RunSummary;
}

/** Display order: from the simplest retriever to the full pipeline. */
export const CONFIG_ORDER = ["vector", "keyword", "hybrid", "vector-rerank", "hybrid-rerank"];

/** The most recent finished run of each config, per split. */
export async function latestRuns(): Promise<RunRow[]> {
  const { rows } = await db.execute<{
    id: string;
    config_name: string;
    split: "dev" | "holdout" | null;
    git_sha: string | null;
    created_at: string;
    summary: RunSummary;
  }>(sql`
    select distinct on (split, config_name) id, config_name, split, git_sha, created_at, summary
    from eval_runs
    where status = 'done' and summary is not null
    order by split, config_name, created_at desc
  `);
  return rows
    .map((r) => ({
      id: r.id,
      configName: r.config_name,
      split: r.split,
      gitSha: r.git_sha,
      createdAt: new Date(r.created_at),
      summary: r.summary,
    }))
    .sort((a, b) => order(a.configName) - order(b.configName));
}

export async function runWithResults(runId: string) {
  const [run] = await db.select().from(evalRuns).where(eq(evalRuns.id, runId));
  if (!run) return null;
  const results = await db
    .select({
      slug: evalQuestions.slug,
      question: evalQuestions.question,
      category: evalQuestions.category,
      gold: evalQuestions.gold,
      recallAt5: evalResults.recallAt5,
      mrr: evalResults.mrr,
      firstRelevantRank: evalResults.firstRelevantRank,
      retrieved: evalResults.retrieved,
      totalMs: evalResults.totalMs,
    })
    .from(evalResults)
    .innerJoin(evalQuestions, eq(evalQuestions.id, evalResults.questionId))
    .where(eq(evalResults.runId, runId))
    .orderBy(asc(evalQuestions.slug));
  return { run: { ...run, summary: run.summary as RunSummary | null }, results };
}

function order(name: string): number {
  const i = CONFIG_ORDER.indexOf(name);
  return i === -1 ? CONFIG_ORDER.length : i;
}
