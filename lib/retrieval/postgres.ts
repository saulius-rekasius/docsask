import { sql } from "drizzle-orm";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type * as schema from "../db/schema";
import { embed } from "../ingest/embed";
import type { ChunkRecord, RetrievalDeps } from "./pipeline";
import { rerank } from "./rerank";

/**
 * Retrieval backed by Postgres (pgvector + full-text search) and Voyage.
 * Takes the database and key as arguments so both the app (lib/retrieval) and
 * scripts (evals) can use it.
 */

export type Database = NeonDatabase<typeof schema>;

export function createPostgresDeps(db: Database, voyageApiKey: () => string): RetrievalDeps {
  return {
    embedQuery: async (query) => (await embed([query], "query", { apiKey: voyageApiKey() })).embeddings[0],

    async vectorSearch(embedding, limit) {
      // `<=>` is cosine distance; ORDER BY it uses the HNSW index.
      const { rows } = await db.execute<{ id: string }>(sql`
        select c.id
        from chunks c
        join documents d on d.id = c.document_id
        where d.status = 'ready' and c.embedding is not null
        order by c.embedding <=> ${JSON.stringify(embedding)}::vector
        limit ${limit}
      `);
      return rows.map((r) => r.id);
    },

    async keywordSearch(query, limit) {
      // BM25 over Postgres full-text search. Two findings from the eval:
      // - websearch_to_tsquery ANDs every word, so a natural-language question
      //   rarely matches anything (2.6% recall@5). Terms are ORed instead.
      // - ts_rank_cd has no IDF, so common words ("page", "use") weigh as much as
      //   rare API names. BM25 weights each term by its rarity (from the
      //   chunk_lexeme_stats view), saturates repeated terms (k1) and normalises
      //   for chunk length (b).
      const { rows } = await db.execute<{ id: string }>(sql`
        with corpus as (
          select count(*)::float8 as n, avg(length(tsv))::float8 as avg_len from chunks
        ),
        terms as (
          select distinct t.lexeme,
                 ln(1 + (corpus.n - coalesce(s.ndoc, 0) + 0.5) / (coalesce(s.ndoc, 0) + 0.5)) as idf
          from corpus,
               unnest(tsvector_to_array(to_tsvector('english', ${query}))) as t(lexeme)
               left join chunk_lexeme_stats s on s.word = t.lexeme
        ),
        q as (
          -- Lexemes are already stemmed, so build the OR query with the 'simple' config.
          select to_tsquery('simple', string_agg(quote_literal(lexeme), ' | ')) as query from terms
        ),
        candidates as (
          select c.id, c.tsv, length(c.tsv) as len
          from chunks c join documents d on d.id = c.document_id, q
          where d.status = 'ready' and q.query is not null and c.tsv @@ q.query
        )
        select c.id
        from candidates c
        cross join lateral unnest(c.tsv) as u(lexeme, positions, weights)
        join terms t on t.lexeme = u.lexeme
        cross join corpus
        group by c.id
        order by sum(
          t.idf * (cardinality(u.positions) * (1.2 + 1))
            / (cardinality(u.positions) + 1.2 * (1 - 0.75 + 0.75 * c.len / corpus.avg_len))
        ) desc, c.id
        limit ${limit}
      `);
      return rows.map((r) => r.id);
    },

    async loadChunks(ids) {
      if (ids.length === 0) return [];
      const { rows } = await db.execute<ChunkRecord & Record<string, unknown>>(sql`
        select c.id, c.heading_path as "headingPath", c.content, c.context,
               d.title as "documentTitle", d.url as "documentUrl", d.section, d.path as "documentPath"
        from chunks c
        join documents d on d.id = c.document_id
        where c.id in (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      `);
      return rows;
    },

    rerank: (query, documents, topK) => rerank(query, documents, topK, { apiKey: voyageApiKey() }),
  };
}
