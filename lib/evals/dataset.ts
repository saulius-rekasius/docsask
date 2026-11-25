import { z } from "zod";
import raw from "./dataset.json";

/**
 * The evaluation set: hand-written questions with section-level gold labels.
 * Tune on "dev"; "holdout" is only for the headline numbers.
 */

export const categories = ["factual", "multi", "recent", "version", "out-of-scope"] as const;

const sectionRef = z.object({ path: z.string().endsWith(".md"), heading: z.string().optional() });

export const evalQuestionSchema = z
  .object({
    id: z.string().regex(/^[a-z]\d{2}-[a-z0-9-]+$/),
    category: z.enum(categories),
    split: z.enum(["dev", "holdout"]),
    question: z.string().min(10),
    /** Reference answer for answer grading (Phase 4b). Optional until then. */
    expectedAnswer: z.string().optional(),
    gold: z.array(
      sectionRef.extend({
        /** Other sections that answer this part equally well; any one satisfies the label. */
        alt: z.array(sectionRef).optional(),
      }),
    ),
  })
  .refine((q) => (q.category === "out-of-scope") === (q.gold.length === 0), {
    message: "out-of-scope questions have no gold; every other question needs at least one",
  });

export type EvalQuestion = z.infer<typeof evalQuestionSchema>;
export type Category = (typeof categories)[number];

export const dataset: EvalQuestion[] = z.array(evalQuestionSchema).parse(raw);
