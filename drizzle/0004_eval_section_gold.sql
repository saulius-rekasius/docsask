ALTER TABLE "eval_questions" ADD COLUMN "slug" text NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_questions" ADD COLUMN "gold" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_questions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_questions" ADD CONSTRAINT "eval_questions_slug_unique" UNIQUE("slug");