/**
 * Ingests the Next.js docs bundled with the installed `next` package.
 *
 *   npm run ingest -- --dry-run        parse + chunk only: corpus stats and cost estimate, no API calls
 *   npm run ingest -- --limit=5        ingest the first 5 documents (a cheap end-to-end test)
 *   npm run ingest -- --only=caching   only documents whose path contains "caching"
 *   npm run ingest                     everything; unchanged documents are skipped
 *   npm run ingest -- --force          re-ingest even if the checksum matches
 *   npm run ingest -- --no-context     skip the Claude context summaries (Voyage only)
 *
 * Idempotent: each document is keyed on (version, path) and skipped when its
 * checksum is unchanged and it is already "ready". A failed document is marked
 * "failed" with the error and retried on the next run. A document indexed with
 * --no-context is revisited by the next run that does write context.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Pool } from "@neondatabase/serverless";
import { config } from "dotenv";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import pLimit from "p-limit";
import * as schema from "../lib/db/schema";
import { chunkDocument, estimateTokens, type Chunk } from "../lib/ingest/chunk";
import {
  contextCostUsd,
  contextualizeDocument,
  documentPrompt,
  emptyUsage,
} from "../lib/ingest/contextualize";
import { embed, embeddingInput, EMBEDDING_MODEL } from "../lib/ingest/embed";
import { parseDoc } from "../lib/ingest/parse";
import { listSourceFiles, type SourceFile } from "../lib/ingest/source";

config({ path: ".env.local", quiet: true });

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

const DRY_RUN = flag("dry-run");
const FORCE = flag("force");
const NO_CONTEXT = flag("no-context");
const LIMIT = option("limit") ? Number(option("limit")) : undefined;
const ONLY = option("only");
const DOC_CONCURRENCY = 3;

const VERSION = `v${JSON.parse(readFileSync(join("node_modules", "next", "package.json"), "utf8")).version}`;

interface Prepared {
  source: SourceFile;
  title: string;
  body: string;
  chunks: Chunk[];
}

function prepare(files: SourceFile[]): Prepared[] {
  return files.map((source) => {
    const parsed = parseDoc(source.raw);
    const title = parsed.title || source.path;
    return { source, title, body: parsed.body, chunks: chunkDocument(title, parsed.body) };
  });
}

function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

function report(docs: Prepared[]) {
  const sizes = docs.flatMap((d) => d.chunks.map((c) => c.tokenCount)).sort((a, b) => a - b);
  const corpusTokens = docs.reduce((n, d) => n + estimateTokens(documentPrompt(d.title, d.body)), 0);
  // Contextualization reads the whole document once per chunk (cached after the first).
  const cacheReads = docs.reduce(
    (n, d) => n + Math.max(0, d.chunks.length - 1) * estimateTokens(documentPrompt(d.title, d.body)),
    0,
  );
  const estimate = contextCostUsd({
    inputTokens: sizes.reduce((a, b) => a + b, 0) + docs.reduce((n, d) => n + d.chunks.length * 120, 0),
    cacheWriteTokens: corpusTokens,
    cacheReadTokens: cacheReads,
    outputTokens: sizes.length * 60,
    requests: sizes.length,
  });

  console.log(`Next.js docs ${VERSION}`);
  console.log(`  documents:          ${docs.length}`);
  console.log(`  chunks:             ${sizes.length}`);
  console.log(
    `  chunk tokens (est): p50 ${percentile(sizes, 50)}, p95 ${percentile(sizes, 95)}, max ${sizes.at(-1)}`,
  );
  console.log(`  corpus tokens (est): ${corpusTokens.toLocaleString()}`);
  console.log(`  est. context cost:  $${estimate.toFixed(2)} (Haiku 5.5, with caching)`);
  const empty = docs.filter((d) => d.chunks.length === 0).map((d) => d.source.path);
  if (empty.length) console.log(`  documents with no chunks: ${empty.join(", ")}`);
}

async function main() {
  let files = await listSourceFiles();
  if (ONLY) files = files.filter((f) => f.path.includes(ONLY));
  if (LIMIT) files = files.slice(0, LIMIT);
  const docs = prepare(files);
  report(docs);
  if (DRY_RUN) return;

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const voyageKey = process.env.VOYAGE_API_KEY;
  const databaseUrl = process.env.DATABASE_URL;
  if ((!anthropicKey && !NO_CONTEXT) || !voyageKey || !databaseUrl) {
    throw new Error(
      "Set ANTHROPIC_API_KEY, VOYAGE_API_KEY and DATABASE_URL in .env.local (or use --dry-run / --no-context).",
    );
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle({ client: pool, schema });
  // The SDK retries 429/5xx with backoff; raise the default for a long batch job.
  const anthropic = NO_CONTEXT ? null : new Anthropic({ apiKey: anthropicKey, maxRetries: 6 });
  const usage = emptyUsage();
  const stats = { ingested: 0, skipped: 0, failed: 0, chunks: 0, embedTokens: 0, embedChars: 0 };
  const started = Date.now();

  // Circuit breaker: errors like a missing credit balance or a bad key fail
  // every document the same way, so stop instead of marking the whole corpus failed.
  const MAX_CONSECUTIVE_FAILURES = 5;
  let consecutiveFailures = 0;
  let aborted = false;

  const ingestOne = async (doc: Prepared) => {
    if (aborted) return;
    const { source } = doc;
    const [existing] = await db
      .select({ id: schema.documents.id, checksum: schema.documents.checksum, status: schema.documents.status })
      .from(schema.documents)
      .where(and(eq(schema.documents.version, VERSION), eq(schema.documents.path, source.path)));
    if (!FORCE && existing?.checksum === source.checksum && existing.status === "ready") {
      // Unchanged and indexed. When writing context, still revisit documents
      // whose chunks were indexed without it (an earlier --no-context run).
      const missing = NO_CONTEXT
        ? 0
        : (
            await db
              .select({ n: count() })
              .from(schema.chunks)
              .where(and(eq(schema.chunks.documentId, existing.id), isNull(schema.chunks.context)))
          )[0].n;
      if (missing === 0) {
        stats.skipped++;
        return;
      }
    }

    const [row] = await db
      .insert(schema.documents)
      .values({
        version: VERSION,
        path: source.path,
        title: doc.title,
        url: source.url,
        section: source.section,
        checksum: source.checksum,
        status: "processing",
      })
      .onConflictDoUpdate({
        target: [schema.documents.version, schema.documents.path],
        set: {
          title: doc.title,
          url: source.url,
          section: source.section,
          checksum: source.checksum,
          status: "processing",
          error: null,
        },
      })
      .returning({ id: schema.documents.id });

    try {
      const contexts = anthropic
        ? await contextualizeDocument(anthropic, doc, doc.chunks, usage)
        : doc.chunks.map(() => "");
      const inputs = doc.chunks.map((c, i) => embeddingInput({ ...c, context: contexts[i] }));
      const { embeddings, totalTokens } = await embed(inputs, "document", { apiKey: voyageKey });
      stats.embedTokens += totalTokens;
      stats.embedChars += inputs.reduce((n, s) => n + s.length, 0);

      await db.transaction(async (tx) => {
        await tx.delete(schema.chunks).where(eq(schema.chunks.documentId, row.id));
        if (doc.chunks.length) {
          await tx.insert(schema.chunks).values(
            doc.chunks.map((c, i) => ({
              documentId: row.id,
              ordinal: c.ordinal,
              headingPath: c.headingPath,
              content: c.content,
              context: contexts[i] || null,
              tokenCount: c.tokenCount,
              embedding: embeddings[i],
            })),
          );
        }
        await tx.update(schema.documents).set({ status: "ready" }).where(eq(schema.documents.id, row.id));
      });
      stats.ingested++;
      stats.chunks += doc.chunks.length;
      consecutiveFailures = 0;
      console.log(`  ✓ ${source.path} (${doc.chunks.length} chunks)`);
    } catch (error) {
      stats.failed++;
      const message = error instanceof Error ? error.message : String(error);
      await db
        .update(schema.documents)
        .set({ status: "failed", error: message.slice(0, 1000) })
        .where(eq(schema.documents.id, row.id));
      console.error(`  ✗ ${source.path}: ${message}`);
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !aborted) {
        aborted = true;
        console.error(`\nStopping: ${MAX_CONSECUTIVE_FAILURES} documents failed in a row. Fix the error above and re-run.`);
      }
    }
  };

  console.log(
    `\nIngesting with ${DOC_CONCURRENCY} documents in parallel${NO_CONTEXT ? ", without context summaries" : ""}…`,
  );
  const limit = pLimit(DOC_CONCURRENCY);
  await Promise.all(docs.map((d) => limit(() => ingestOne(d))));
  if (stats.ingested > 0) {
    // Keyword search reads document frequencies from this view (BM25 IDF).
    // CONCURRENTLY keeps it readable while it refreshes; it needs the unique index.
    await db.execute(sql`refresh materialized view concurrently chunk_lexeme_stats`);
  }
  await pool.end();

  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  const total = usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
  const notRun = docs.length - stats.ingested - stats.skipped - stats.failed;
  console.log(
    `\n${aborted ? "Stopped" : "Done"} in ${seconds}s: ${stats.ingested} ingested, ${stats.skipped} unchanged, ${stats.failed} failed` +
      (notRun ? `, ${notRun} not attempted` : ""),
  );
  console.log(`  chunks written:  ${stats.chunks}`);
  console.log(
    `  Haiku requests:  ${usage.requests}, prompt tokens ${total.toLocaleString()} ` +
      `(${total ? Math.round((usage.cacheReadTokens / total) * 100) : 0}% from cache), output ${usage.outputTokens.toLocaleString()}`,
  );
  console.log(`  context cost:    $${contextCostUsd(usage).toFixed(3)}`);
  console.log(
    `  ${EMBEDDING_MODEL} tokens: ${stats.embedTokens.toLocaleString()}` +
      (stats.embedTokens ? ` (${(stats.embedChars / stats.embedTokens).toFixed(2)} chars/token)` : ""),
  );
  if (stats.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
