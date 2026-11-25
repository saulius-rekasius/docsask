/**
 * Retrieval evaluation: runs each search configuration over the question set
 * and scores it against the section-level gold labels.
 *
 *   npm run eval -- --check                    verify every gold label matches chunks (no API calls)
 *   npm run eval -- --check --dump=gold.md     also write the gold passages to a file
 *   npm run eval                               all configs on the dev split, stored in the database
 *   npm run eval -- --split=holdout            the held-out split (headline numbers only)
 *   npm run eval -- --configs=hybrid,hybrid-rerank --no-store
 *
 * Out-of-scope questions are retrieved too but excluded from the retrieval
 * metrics; their top rerank score is reported to inform a refusal threshold.
 */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Pool } from "@neondatabase/serverless";
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import pLimit from "p-limit";
import * as schema from "../lib/db/schema";
import { categories, dataset, type EvalQuestion } from "../lib/evals/dataset";
import { meanScores, percentile, satisfies, scoreQuestion, firstRelevantRank, type QuestionScores } from "../lib/evals/metrics";
import { retrieve, type RetrievalOptions } from "../lib/retrieval/pipeline";
import { createPostgresDeps } from "../lib/retrieval/postgres";

config({ path: ".env.local", quiet: true });

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

export const CONFIGS: Record<string, RetrievalOptions> = {
  vector: { retrievers: ["vector"], rerank: false },
  keyword: { retrievers: ["keyword"], rerank: false },
  hybrid: { retrievers: ["vector", "keyword"], rerank: false },
  "vector-rerank": { retrievers: ["vector"], rerank: true },
  "hybrid-rerank": { retrievers: ["vector", "keyword"], rerank: true },
};
// Score the top 10; the app shows 6.
const SHARED: RetrievalOptions = { topK: 10, candidates: 30, rerankCandidates: 20 };

const SPLIT = option("split") ?? "dev";
const CONFIG_NAMES = option("configs")?.split(",") ?? Object.keys(CONFIGS);
const STORE = !flag("no-store");

const pct = (x: number) => (Number.isNaN(x) ? "  —  " : `${(x * 100).toFixed(1)}%`.padStart(6));

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Set DATABASE_URL in .env.local");
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle({ client: pool, schema });

  const questions = dataset.filter((q) => SPLIT === "all" || q.split === SPLIT);
  const ids = await syncQuestions(db);

  if (flag("check")) {
    await check(db, questions, option("dump"));
    await pool.end();
    return;
  }

  const unknown = CONFIG_NAMES.filter((c) => !CONFIGS[c]);
  if (unknown.length) throw new Error(`Unknown config(s): ${unknown.join(", ")}`);
  const voyageKey = process.env.VOYAGE_API_KEY;
  if (!voyageKey) throw new Error("Set VOYAGE_API_KEY in .env.local");
  const deps = createPostgresDeps(db, () => voyageKey);
  const gitSha = gitHead();

  console.log(`Evaluating ${questions.length} ${SPLIT} questions × ${CONFIG_NAMES.length} configs (git ${gitSha ?? "unknown"})\n`);
  const rows: { name: string; overall: ReturnType<typeof meanScores>; p50: number; p95: number; oosTop: number; inTop: number }[] = [];
  const perCategory: Record<string, Record<string, number>> = {};
  const misses: string[] = [];

  for (const name of CONFIG_NAMES) {
    const options = { ...SHARED, ...CONFIGS[name] };
    const [run] = STORE
      ? await db
          .insert(schema.evalRuns)
          .values({ configName: name, params: options, gitSha, split: SPLIT === "all" ? null : (SPLIT as "dev" | "holdout"), status: "running" })
          .returning({ id: schema.evalRuns.id })
      : [undefined];

    const limit = pLimit(4);
    const results = await Promise.all(
      questions.map((q) =>
        limit(async () => {
          const result = await retrieve(q.question, deps, options);
          const retrieved = result.hits.map((h) => ({ documentPath: h.documentPath, headingPath: h.headingPath }));
          const scores = scoreQuestion(retrieved, q.gold);
          return { q, result, scores, firstRank: firstRelevantRank(retrieved, q.gold) };
        }),
      ),
    );

    if (run) {
      await db.insert(schema.evalResults).values(
        results.map(({ q, result, scores, firstRank }) => ({
          runId: run.id,
          questionId: ids.get(q.id)!,
          retrievedIds: result.hits.map((h) => h.id),
          retrieved: result.hits.map((h) => ({
            chunkId: h.id,
            documentPath: h.documentPath,
            headingPath: h.headingPath,
            url: h.url,
            relevant: q.gold.some((g) => satisfies(h, g)),
            vectorRank: h.vectorRank,
            keywordRank: h.keywordRank,
            rerankScore: h.rerankScore,
          })),
          ...finite(scores),
          firstRelevantRank: firstRank ?? null,
          totalMs: result.timingsMs.total,
        })),
      );
    }

    const overall = meanScores(results.map((r) => r.scores));
    const latencies = results.map((r) => r.result.timingsMs.total);
    const topScore = (inScope: boolean) => {
      const s = results.filter((r) => (r.q.category !== "out-of-scope") === inScope).map((r) => r.result.hits[0]?.rerankScore ?? NaN);
      return s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN;
    };
    const byCategory = Object.fromEntries(
      categories
        .filter((c) => c !== "out-of-scope")
        .map((c) => [c, meanScores(results.filter((r) => r.q.category === c).map((r) => r.scores))]),
    );
    perCategory[name] = Object.fromEntries(Object.entries(byCategory).map(([c, m]) => [c, m.recallAt5]));
    rows.push({ name, overall, p50: percentile(latencies, 50), p95: percentile(latencies, 95), inTop: topScore(true), oosTop: topScore(false) });

    for (const r of results) {
      if (r.q.category !== "out-of-scope" && r.scores.recallAt5 < 1) {
        misses.push(`${name}\t${r.q.id}\tR@5 ${pct(r.scores.recallAt5).trim()}\tfirst relevant: ${r.firstRank ?? "none in top 10"}\ttop: ${r.result.hits[0]?.headingPath}`);
      }
    }

    if (run) {
      await db
        .update(schema.evalRuns)
        .set({
          status: "done",
          finishedAt: new Date(),
          summary: { overall: finite(overall), byCategory: mapValues(byCategory, finite), latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) }, n: questions.length },
        })
        .where(sql`${schema.evalRuns.id} = ${run.id}`);
    }
    console.log(`  ✓ ${name}`);
  }

  console.log(`\n${"config".padEnd(15)}    R@5   R@10    MRR nDCG@5  Hit@1   p50ms  p95ms`);
  for (const r of rows) {
    const o = r.overall;
    console.log(
      `${r.name.padEnd(15)} ${pct(o.recallAt5)} ${pct(o.recallAt10)} ${pct(o.mrr)} ${pct(o.ndcgAt5)} ${pct(o.hitAt1)} ${String(r.p50).padStart(7)} ${String(r.p95).padStart(6)}`,
    );
  }
  const cats = categories.filter((c) => c !== "out-of-scope");
  console.log(`\nRecall@5 by category\n${"config".padEnd(15)} ${cats.map((c) => c.padStart(8)).join(" ")}`);
  for (const r of rows) console.log(`${r.name.padEnd(15)} ${cats.map((c) => pct(perCategory[r.name][c]).padStart(8)).join(" ")}`);
  const reranked = rows.find((r) => r.name === "hybrid-rerank");
  if (reranked) {
    console.log(`\nMean top-1 rerank score: in scope ${reranked.inTop.toFixed(2)}, out of scope ${reranked.oosTop.toFixed(2)}`);
  }
  const missFile = option("misses");
  if (missFile) {
    writeFileSync(missFile, misses.join("\n") + "\n");
    console.log(`\n${misses.length} misses written to ${missFile}`);
  }
  await pool.end();
}

/** Upserts the dataset into eval_questions; returns dataset id → row id. */
async function syncQuestions(db: ReturnType<typeof drizzle<typeof schema>>) {
  const rows = await db
    .insert(schema.evalQuestions)
    .values(
      dataset.map((q) => ({
        slug: q.id,
        question: q.question,
        expectedAnswer: q.expectedAnswer ?? null,
        gold: q.gold,
        category: q.category,
        split: q.split,
      })),
    )
    .onConflictDoUpdate({
      target: schema.evalQuestions.slug,
      set: {
        question: sql`excluded.question`,
        expectedAnswer: sql`excluded.expected_answer`,
        gold: sql`excluded.gold`,
        category: sql`excluded.category`,
        split: sql`excluded.split`,
      },
    })
    .returning({ id: schema.evalQuestions.id, slug: schema.evalQuestions.slug });
  return new Map(rows.map((r) => [r.slug, r.id]));
}

/** Every gold label must match at least one chunk; optionally dump the matching passages. */
async function check(db: ReturnType<typeof drizzle<typeof schema>>, questions: EvalQuestion[], dumpPath?: string) {
  const { rows } = await db.execute<{ documentPath: string; headingPath: string; content: string }>(sql`
    select d.path as "documentPath", c.heading_path as "headingPath", c.content
    from chunks c join documents d on d.id = c.document_id
    where d.status = 'ready' order by d.path, c.ordinal
  `);
  const problems: string[] = [];
  const dump: string[] = [];
  for (const q of questions) {
    dump.push(`\n## ${q.id} (${q.category}, ${q.split})\nQ: ${q.question}`);
    for (const g of q.gold) {
      // Each section of the label (main and every alternative) must exist on its own.
      for (const section of [g, ...(g.alt ?? [])]) {
        if (!rows.some((r) => satisfies(r, section))) {
          problems.push(`${q.id}: no chunk matches ${section.path}${section.heading ? ` :: ${section.heading}` : ""}`);
        }
      }
      const matches = rows.filter((r) => satisfies(r, g));
      dump.push(`\n### gold: ${g.path}${g.heading ? ` :: ${g.heading}` : ""}${g.alt ? ` (+${g.alt.length} alt)` : ""} (${matches.length} chunks)`);
      const perLabel = Number(option("dump-chunks") ?? 3);
      const chars = Number(option("dump-chars") ?? 1200);
      for (const m of matches.slice(0, perLabel)) dump.push(`[${m.headingPath}]\n${m.content.slice(0, chars)}`);
    }
  }
  const counts = Object.fromEntries(categories.map((c) => [c, questions.filter((q) => q.category === c).length]));
  console.log(`${questions.length} questions (${SPLIT}): ${JSON.stringify(counts)}`);
  if (dumpPath) {
    writeFileSync(dumpPath, dump.join("\n"));
    console.log(`Gold passages written to ${dumpPath}`);
  }
  if (problems.length) {
    console.error(`\n${problems.length} gold label(s) match no chunks:\n  ${problems.join("\n  ")}`);
    process.exitCode = 1;
  } else {
    console.log("All gold labels match at least one chunk.");
  }
}

/** Short commit SHA, with "-dirty" when the working tree has uncommitted changes. */
function gitHead(): string | null {
  try {
    const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain --untracked-files=no", { encoding: "utf8" }).trim() !== "";
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return null;
  }
}

/** Postgres rejects NaN in double columns from JSON; store null instead. */
function finite<T extends object>(scores: T): { [K in keyof T]: T[K] | null } {
  return Object.fromEntries(
    Object.entries(scores).map(([k, v]) => [k, typeof v === "number" && !Number.isFinite(v) ? null : v]),
  ) as { [K in keyof T]: T[K] | null };
}

function mapValues<T, U>(obj: Record<string, T>, fn: (v: T) => U): Record<string, U> {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
}

export type { QuestionScores };

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
