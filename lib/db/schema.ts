import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/** voyage-4 default output dimension. Changing it requires re-embedding. */
export const EMBEDDING_DIMENSIONS = 1024;

const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// Better Auth core tables (user, session, account, verification)
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// ---------------------------------------------------------------------------
// Corpus: ingested Next.js docs
// ---------------------------------------------------------------------------

export const documentStatus = pgEnum("document_status", [
  "pending",
  "processing",
  "ready",
  "failed",
]);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    version: text("version").notNull(), // git tag, e.g. "v16.4.6"
    path: text("path").notNull(), // repo path, e.g. "docs/01-app/..."
    title: text("title").notNull(),
    url: text("url").notNull(), // nextjs.org URL
    section: text("section"),
    checksum: text("checksum").notNull(),
    status: documentStatus("status").notNull().default("pending"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // Unique so re-running ingestion upserts instead of duplicating.
  (t) => [uniqueIndex("documents_version_path_idx").on(t.version, t.path)],
);

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    headingPath: text("heading_path").notNull(),
    content: text("content").notNull(),
    /** Contextual Retrieval prefix written by the model at ingestion time. */
    context: text("context"),
    tokenCount: integer("token_count").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    tsv: tsvector("tsv").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(context, '') || ' ' || heading_path || ' ' || content)`,
    ),
    createdAt: createdAt(),
  },
  (t) => [
    index("chunks_document_id_idx").on(t.documentId),
    index("chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("chunks_tsv_idx").using("gin", t.tsv),
  ],
);

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export const messageRole = pgEnum("message_role", ["user", "assistant"]);
export const answerRoute = pgEnum("answer_route", ["rag", "agent", "refusal"]);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New conversation"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("conversations_user_id_idx").on(t.userId)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: messageRole("role").notNull(),
    content: text("content").notNull(),
    citations: jsonb("citations"),
    route: answerRoute("route"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    costUsd: doublePrecision("cost_usd"),
    ttftMs: integer("ttft_ms"),
    totalMs: integer("total_ms"),
    createdAt: createdAt(),
  },
  (t) => [index("messages_conversation_id_idx").on(t.conversationId)],
);

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export const evalSplit = pgEnum("eval_split", ["dev", "holdout"]);
export const evalRunStatus = pgEnum("eval_run_status", [
  "queued",
  "running",
  "done",
  "failed",
]);

/** Gold label: a document and optionally a heading path (see lib/evals/metrics.ts). */
export type GoldRef = { path: string; heading?: string; alt?: { path: string; heading?: string }[] };

/** Snapshot of one retrieved chunk, kept so results stay readable after re-ingestion. */
export type RetrievedSnapshot = {
  chunkId: string;
  documentPath: string;
  headingPath: string;
  url: string;
  relevant: boolean;
  vectorRank?: number;
  keywordRank?: number;
  rerankScore?: number;
};

/** Mirrors lib/evals/dataset.json; upserted by the eval runner on `slug`. */
export const evalQuestions = pgTable("eval_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  question: text("question").notNull(),
  expectedAnswer: text("expected_answer"),
  // Section-level labels instead of chunk ids, which change on every re-ingest.
  gold: jsonb("gold").$type<GoldRef[]>().notNull().default([]),
  category: text("category").notNull(),
  split: evalSplit("split").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const evalRuns = pgTable("eval_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  configName: text("config_name").notNull(),
  params: jsonb("params").notNull(),
  gitSha: text("git_sha"),
  split: evalSplit("split"),
  status: evalRunStatus("status").notNull().default("queued"),
  /** Aggregate metrics, overall and per category, written when the run finishes. */
  summary: jsonb("summary"),
  createdAt: createdAt(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const evalResults = pgTable(
  "eval_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => evalRuns.id, { onDelete: "cascade" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => evalQuestions.id, { onDelete: "cascade" }),
    retrievedIds: uuid("retrieved_ids").array().notNull().default(sql`'{}'`),
    retrieved: jsonb("retrieved").$type<RetrievedSnapshot[]>(),
    answer: text("answer"),
    recallAt5: doublePrecision("recall_at_5"),
    recallAt10: doublePrecision("recall_at_10"),
    mrr: doublePrecision("mrr"),
    ndcgAt5: doublePrecision("ndcg_at_5"),
    hitAt1: doublePrecision("hit_at_1"),
    firstRelevantRank: integer("first_relevant_rank"),
    correctness: doublePrecision("correctness"),
    groundedness: doublePrecision("groundedness"),
    refusalCorrect: boolean("refusal_correct"),
    judgeReasoning: text("judge_reasoning"),
    costUsd: doublePrecision("cost_usd"),
    ttftMs: integer("ttft_ms"),
    totalMs: integer("total_ms"),
    createdAt: createdAt(),
  },
  (t) => [index("eval_results_run_id_idx").on(t.runId)],
);

export const judgeCalibration = pgTable("judge_calibration", {
  id: uuid("id").primaryKey().defaultRandom(),
  questionId: uuid("question_id")
    .notNull()
    .references(() => evalQuestions.id, { onDelete: "cascade" }),
  humanScore: doublePrecision("human_score").notNull(),
  judgeScore: doublePrecision("judge_score").notNull(),
  createdAt: createdAt(),
});
