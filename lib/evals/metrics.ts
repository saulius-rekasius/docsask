import { HEADING_SEPARATOR } from "../ingest/chunk";

/**
 * Retrieval metrics against section-level gold labels.
 *
 * A gold label names a document and, optionally, a heading path. A retrieved
 * chunk satisfies it when it comes from that document and sits at or under
 * that heading. Labels survive re-ingestion (chunk ids do not), and a section
 * that was split into several chunks counts once.
 */

export interface SectionRef {
  path: string;
  /** Heading path as stored on chunks, e.g. "cacheLife › Reference › Preset cache profiles". Omit for "anywhere in the document". */
  heading?: string;
}

/** A required piece of the answer: its main section, or any alternative section that answers equally well. */
export interface GoldRef extends SectionRef {
  alt?: SectionRef[];
}

export interface RetrievedRef {
  documentPath: string;
  headingPath: string;
}

export function satisfies(chunk: RetrievedRef, gold: GoldRef): boolean {
  return [gold, ...(gold.alt ?? [])].some((ref) => inSection(chunk, ref));
}

function inSection(chunk: RetrievedRef, ref: SectionRef): boolean {
  if (chunk.documentPath !== ref.path) return false;
  if (!ref.heading) return true;
  return chunk.headingPath === ref.heading || chunk.headingPath.startsWith(ref.heading + HEADING_SEPARATOR);
}

/** For each retrieved position, the index of the first gold label it newly satisfies, or -1. */
function gains(retrieved: RetrievedRef[], gold: GoldRef[]): number[] {
  const found = new Set<number>();
  return retrieved.map((chunk) => {
    const g = gold.findIndex((ref, i) => !found.has(i) && satisfies(chunk, ref));
    if (g !== -1) found.add(g);
    return g;
  });
}

/** Fraction of gold labels satisfied within the top k. */
export function recallAtK(retrieved: RetrievedRef[], gold: GoldRef[], k: number): number {
  if (gold.length === 0) return NaN;
  return gains(retrieved.slice(0, k), gold).filter((g) => g !== -1).length / gold.length;
}

/** 1 / rank of the first relevant chunk within the top k, or 0. */
export function reciprocalRank(retrieved: RetrievedRef[], gold: GoldRef[], k = 10): number {
  if (gold.length === 0) return NaN;
  const rank = retrieved.slice(0, k).findIndex((c) => gold.some((g) => satisfies(c, g)));
  return rank === -1 ? 0 : 1 / (rank + 1);
}

/** Binary nDCG@k: each gold label earns gain once, at the first position that satisfies it. */
export function ndcgAtK(retrieved: RetrievedRef[], gold: GoldRef[], k: number): number {
  if (gold.length === 0) return NaN;
  const dcg = gains(retrieved.slice(0, k), gold).reduce((sum, g, i) => (g === -1 ? sum : sum + 1 / Math.log2(i + 2)), 0);
  let ideal = 0;
  for (let i = 0; i < Math.min(gold.length, k); i++) ideal += 1 / Math.log2(i + 2);
  return dcg / ideal;
}

/** 1-based rank of the first relevant chunk, or undefined. */
export function firstRelevantRank(retrieved: RetrievedRef[], gold: GoldRef[]): number | undefined {
  const i = retrieved.findIndex((c) => gold.some((g) => satisfies(c, g)));
  return i === -1 ? undefined : i + 1;
}

export interface QuestionScores {
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  ndcgAt5: number;
  hitAt1: number;
}

export function scoreQuestion(retrieved: RetrievedRef[], gold: GoldRef[]): QuestionScores {
  return {
    recallAt5: recallAtK(retrieved, gold, 5),
    recallAt10: recallAtK(retrieved, gold, 10),
    mrr: reciprocalRank(retrieved, gold, 10),
    ndcgAt5: ndcgAtK(retrieved, gold, 5),
    hitAt1: reciprocalRank(retrieved, gold, 1),
  };
}

/** Mean of each metric, ignoring NaN (questions without gold, e.g. out-of-scope). */
export function meanScores(scores: QuestionScores[]): QuestionScores & { n: number } {
  const valid = scores.filter((s) => !Number.isNaN(s.recallAt5));
  const mean = (key: keyof QuestionScores) =>
    valid.length ? valid.reduce((sum, s) => sum + s[key], 0) / valid.length : NaN;
  return {
    n: valid.length,
    recallAt5: mean("recallAt5"),
    recallAt10: mean("recallAt10"),
    mrr: mean("mrr"),
    ndcgAt5: mean("ndcgAt5"),
    hitAt1: mean("hitAt1"),
  };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
