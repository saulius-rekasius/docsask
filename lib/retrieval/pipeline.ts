import { HEADING_SEPARATOR } from "../ingest/chunk";
import { reciprocalRankFusion } from "./rrf";

/**
 * Hybrid retrieval:
 *
 *   query ─┬─ embed → vector search (cosine, top N) ─┐
 *          └─ keyword search (Postgres FTS, top N) ──┴─ RRF → rerank-3 → top K
 *
 * Vector search finds paraphrases ("make a function remember its result");
 * keyword search finds exact API names (`cacheLife`, `revalidateTag`). RRF
 * merges the two lists, and the reranker reads each candidate against the
 * query to order the final few. If reranking fails, the fused order is used.
 *
 * Data access is injected so the ranking logic is testable without a database.
 */

export interface ChunkRecord {
  id: string;
  headingPath: string;
  content: string;
  context: string | null;
  documentTitle: string;
  documentUrl: string;
  /** Path of the source file within the docs, e.g. "01-app/02-guides/caching.md". */
  documentPath: string;
  section: string | null;
}

export interface RetrievalDeps {
  embedQuery(query: string): Promise<number[]>;
  vectorSearch(embedding: number[], limit: number): Promise<string[]>;
  keywordSearch(query: string, limit: number): Promise<string[]>;
  loadChunks(ids: string[]): Promise<ChunkRecord[]>;
  rerank(query: string, documents: string[], topK: number): Promise<{ index: number; score: number }[]>;
}

export interface RetrievalOptions {
  /** Candidates taken from each retriever. */
  candidates?: number;
  /** Fused candidates sent to the reranker. */
  rerankCandidates?: number;
  /** Results returned. */
  topK?: number;
  rerank?: boolean;
  /** Which first-stage retrievers to run. Both by default (hybrid). */
  retrievers?: Retriever[];
}

export type Retriever = "vector" | "keyword";

export interface Hit extends ChunkRecord {
  /** Link to the section on nextjs.org. */
  url: string;
  vectorRank?: number;
  keywordRank?: number;
  fusedRank: number;
  fusedScore: number;
  rerankScore?: number;
}

export interface RetrievalResult {
  hits: Hit[];
  reranked: boolean;
  /** Why reranking was skipped, when it was requested but failed. */
  rerankError?: string;
  timingsMs: { search: number; rerank: number; total: number };
}

export async function retrieve(
  query: string,
  deps: RetrievalDeps,
  {
    candidates = 30,
    rerankCandidates = 20,
    topK = 6,
    rerank = true,
    retrievers = ["vector", "keyword"],
  }: RetrievalOptions = {},
): Promise<RetrievalResult> {
  const t0 = performance.now();
  const [vectorIds, keywordIds] = await Promise.all([
    retrievers.includes("vector")
      ? deps.embedQuery(query).then((e) => deps.vectorSearch(e, candidates))
      : Promise.resolve([]),
    retrievers.includes("keyword") ? deps.keywordSearch(query, candidates) : Promise.resolve([]),
  ]);
  const fused = reciprocalRankFusion([vectorIds, keywordIds]);
  const pool = fused.slice(0, rerank ? rerankCandidates : topK);
  const records = new Map((await deps.loadChunks(pool.map((f) => f.id))).map((r) => [r.id, r]));
  const t1 = performance.now();

  const candidatesHits: Hit[] = pool.flatMap((f, i) => {
    const record = records.get(f.id);
    if (!record) return [];
    return [
      {
        ...record,
        url: sectionUrl(record.documentUrl, record.headingPath),
        vectorRank: f.ranks[0],
        keywordRank: f.ranks[1],
        fusedRank: i + 1,
        fusedScore: f.score,
      },
    ];
  });

  let hits = candidatesHits.slice(0, topK);
  let reranked = false;
  let rerankError: string | undefined;
  if (rerank && candidatesHits.length > 0) {
    try {
      const scores = await deps.rerank(query, candidatesHits.map(rerankText), topK);
      hits = scores.map((s) => ({ ...candidatesHits[s.index], rerankScore: s.score }));
      reranked = true;
    } catch (error) {
      rerankError = error instanceof Error ? error.message : String(error);
    }
  }
  const t2 = performance.now();

  return {
    hits,
    reranked,
    rerankError,
    timingsMs: { search: Math.round(t1 - t0), rerank: Math.round(t2 - t1), total: Math.round(t2 - t0) },
  };
}

/** What the reranker reads: the same text the embedding was built from. */
export function rerankText(hit: Pick<Hit, "context" | "headingPath" | "content">): string {
  return [hit.context, hit.headingPath, hit.content].filter(Boolean).join("\n\n");
}

/** Deep link to a section: the document URL plus the anchor of the chunk's last heading. */
export function sectionUrl(documentUrl: string, headingPath: string): string {
  const parts = headingPath.split(HEADING_SEPARATOR);
  if (parts.length < 2) return documentUrl;
  return `${documentUrl}#${slugify(parts.at(-1)!)}`;
}

/** Heading anchor in the style nextjs.org uses (GitHub-like slugs). */
export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}
