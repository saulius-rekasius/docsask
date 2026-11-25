-- Document frequency of every lexeme in the corpus, for BM25 keyword scoring.
-- Postgres ts_rank / ts_rank_cd have no IDF term, so common words weigh as much
-- as rare API names. Refreshed by scripts/ingest.ts after each run.
-- The table is schema-qualified because Postgres 17 runs materialized view
-- queries with a restricted search_path.
CREATE MATERIALIZED VIEW "chunk_lexeme_stats" AS
SELECT word, ndoc FROM ts_stat('SELECT tsv FROM public.chunks');--> statement-breakpoint
CREATE UNIQUE INDEX "chunk_lexeme_stats_word_idx" ON "chunk_lexeme_stats" ("word");
