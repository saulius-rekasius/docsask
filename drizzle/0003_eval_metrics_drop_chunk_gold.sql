ALTER TABLE "eval_questions" ALTER COLUMN "expected_answer" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN "retrieved" jsonb;--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN "recall_at_10" double precision;--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN "ndcg_at_5" double precision;--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN "hit_at_1" double precision;--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN "first_relevant_rank" integer;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "split" "eval_split";--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "summary" jsonb;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "eval_questions" DROP COLUMN "gold_chunk_ids";