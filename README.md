# DocsAsk

Ask questions about the Next.js documentation and get streamed answers that cite the exact passage they came from. Includes an evaluation dashboard that measures retrieval and answer quality.

**Live demo:** https://docsask-black.vercel.app (sign in with GitHub)

> **Status:** ingestion, hybrid search and the retrieval evaluation are done; answer generation with Claude is next. See `PLAN.md` for the full roadmap.

## Stack

Next.js 16.4 (App Router, Cache Components, `proxy.ts`) · React 19 · TypeScript 6 · Tailwind CSS 4 · shadcn/ui (Base UI) · Better Auth (GitHub) · Neon Postgres + pgvector · Drizzle ORM · Vitest · GitHub Actions

Coming next: Claude API (`@anthropic-ai/sdk`), Voyage embeddings and reranking, Vercel Workflows.

## Local setup

Requirements: Node.js 24+, a [Neon](https://neon.tech) database, a GitHub OAuth app.

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the env template and fill it in:
   ```bash
   cp .env.example .env.local
   ```
   - `DATABASE_URL`: Neon connection string
   - `BETTER_AUTH_SECRET`: generate one with `npx @better-auth/cli secret`
   - `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`: from a GitHub OAuth app with callback URL `http://localhost:3000/api/auth/callback/github`
3. Create the database tables (the first migration enables pgvector):
   ```bash
   npm run db:migrate
   ```
4. Start the dev server:
   ```bash
   npm run dev
   ```

## Ingestion

The corpus is the Next.js documentation that ships inside the installed `next` package (`node_modules/next/dist/docs`), so it always matches the version the app runs on. App Router docs plus the Architecture and Community sections are indexed; the legacy Pages Router docs are not.

```bash
npm run ingest -- --dry-run    # stats and cost estimate, no API calls
npm run ingest -- --limit=5    # small end-to-end test
npm run ingest                 # everything; unchanged documents are skipped
```

Pipeline per document (`lib/ingest/`):

1. **Parse** (`parse.ts`): read frontmatter, keep App Router content, drop Pages Router-only sections, MDX comments and layout components. Of each TypeScript/JavaScript code-block pair, only the TypeScript one is kept; of the package-manager variants, only npm.
2. **Chunk** (`chunk.ts`): split at headings, pack paragraphs up to ~500 tokens, never split a code block, split large tables by rows with the header repeated. Each chunk records its heading path, e.g. `use cache › Cache lifetimes`.
3. **Contextualize** (`contextualize.ts`): [Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval). Claude Haiku 5.5 writes 1–2 sentences placing each chunk in its document. The full document sits in a cached prompt prefix, and the first chunk runs alone so the rest read that cache.
4. **Embed** (`embed.ts`): Voyage `voyage-4`, 1024 dimensions, batched within API limits, retries with backoff on 429/5xx.
5. **Store**: one transaction per document. Keyed on version + path; skipped when the checksum is unchanged.

Current corpus (v16.4.6): 307 documents, ~2,500 chunks, ~715K tokens. Contextualization costs about $0.40 per full run.

## Search

`/search` runs the retrieval pipeline (`lib/retrieval/`) and shows each passage with the signals that ranked it:

```
query ─┬─ embed (voyage-4) → pgvector cosine top 30 ──┐
       └─ BM25 over Postgres full-text search top 30 ─┴─ RRF (k=60) → rerank-3 → top 6
```

Postgres `ts_rank_cd` has no IDF, so keyword scoring is BM25 written in SQL: document frequencies come from a materialized view over the full-text index (`chunk_lexeme_stats`, refreshed after each ingest).

## Evaluation

60 hand-written questions (`lib/evals/dataset.json`) in five categories: factual (22), multi-passage (12), new in 16.3/16.4 (10), version changes (8) and out of scope (8). Each answerable question is labelled with the doc **sections** that answer it (document path + heading), not chunk ids, so labels survive re-ingestion. A label can list alternative sections that answer equally well. Split: 45 dev for tuning, 15 held out.

```bash
npm run eval -- --check             # every gold label must match real chunks
npm run eval                        # all configs on dev, stored in eval_runs / eval_results
npm run eval -- --split=holdout     # held-out split, for headline numbers only
```

Results are browsable at `/evals`, with a per-question drill-down for every run.

**Held-out results** (13 answerable questions, run once; one question ≈ 8 points):

| Configuration | Recall@5 | MRR | Hit@1 | p50 latency |
|---|---|---|---|---|
| Vector (voyage-4) | 88.5% | 76.5% | 69.2% | 382 ms |
| Keyword (BM25) | 73.1% | 58.3% | 46.2% | 222 ms |
| Hybrid (RRF) | 76.9% | 66.2% | 53.8% | 371 ms |
| **Vector + rerank-3** | **96.2%** | **90.0%** | **84.6%** | 654 ms |
| Hybrid + rerank-3 | 96.2% | 86.2% | 76.9% | 654 ms |

The dev split (39 answerable questions) agrees: rerank-3 lifts MRR from 75% to 88.5% and puts a relevant passage first 79.5% of the time.

**What the evaluation found:**

- **Keyword search was nearly useless at first: 2.6% recall@5.** `websearch_to_tsquery` ANDs every word, so natural-language questions matched almost nothing. ORing the terms raised it to 39.7%, and replacing `ts_rank_cd` (no IDF) with BM25 raised it to 65.4% (dev split, same labels throughout).
- **Even fixed, keyword search adds no recall here.** voyage-4 already handles exact API names, and on the held-out split plain hybrid is worse than vector alone because RRF gives the weaker list equal weight. The reranker absorbs the difference.
- **Reranking is the largest single gain**, mostly in ranking quality (MRR, hit@1) rather than recall.
- **Multi-passage questions are the weak spot** (77.8% on dev): the second source is often missed. Query decomposition or the planned agent mode should target this.
- **The top rerank score separates in-scope from out-of-scope questions** (0.88 vs 0.36–0.60 on average), a usable signal for refusing to answer.
- Building the set surfaced two pipeline bugs: heading cleanup stripped underscores (`unstable_cache` became `unstablecache`), and chunker changes never re-ran because skipping was keyed on the file checksum alone. Both are fixed; the checksum now includes a pipeline version.

**Caveats:** the questions and labels were written with AI assistance and checked against the source passages, not written by independent annotators. Three dev labels gained alternative sections after the first run showed the retrieved passage also answered the question; held-out labels were not changed. The set has no identifier-only queries (e.g. a bare `bodySizeLimit`), where keyword search should help most.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Dev server on http://localhost:3000 |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | Generate route types, then `tsc --noEmit` |
| `npm test` | Unit tests (Vitest) |
| `npm run db:generate` | Generate a migration from `lib/db/schema.ts` |
| `npm run db:migrate` | Apply migrations |
| `npm run db:studio` | Browse the database |
| `npm run ingest` | Index the Next.js docs (see Ingestion) |
| `npm run eval` | Retrieval evaluation (see Evaluation) |

## Project layout

```
app/                 routes (landing, sign-in, (app)/dashboard, api/auth)
proxy.ts             optimistic auth gate for app routes
lib/env.ts           Zod-validated environment
lib/auth.ts          Better Auth server config
lib/db/schema.ts     all tables: auth, corpus, chat, evals
lib/ingest/          parse, chunk, contextualize, embed
lib/retrieval/       vector, BM25, RRF, rerank, pipeline
lib/evals/           dataset, metrics, queries for /evals
scripts/ingest.ts    ingestion CLI
scripts/eval-retrieval.ts  evaluation runner
drizzle/             SQL migrations
tests/unit/          Vitest tests
```

## Credits

The indexed documentation is from [Next.js](https://github.com/vercel/next.js), © Vercel, Inc., MIT License. Answers link back to the original pages on nextjs.org.

## Decisions that differ from the original plan

- **npm instead of pnpm:** pnpm isn't installed on the dev machine, and Node 25+ no longer ships Corepack. Easy to switch later.
- **TypeScript 6.0 instead of 7:** `typescript-eslint` (used by `eslint-config-next`) doesn't support TypeScript 7 yet.
- **`/library` instead of `/docs`** for the ingested-docs page, to avoid confusion with the Next.js docs themselves.
- **Docs from the installed package instead of a GitHub download:** Next.js bundles its docs in `node_modules/next/dist/docs`, so the corpus is version-locked to the app with no network fetch.
- **No chunk overlap:** each chunk carries its heading path and a generated context sentence, which covers what overlap would add, without duplicate text in the index.
- **Ingestion runs as a script for now:** the planned Vercel Workflow and `/library` page come in a follow-up. The pipeline modules are written so a workflow can call them step by step.
