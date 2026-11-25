import { describe, expect, it } from "vitest";
import { categories, dataset } from "@/lib/evals/dataset";

describe("evaluation dataset", () => {
  it("has 60 questions with unique ids", () => {
    expect(dataset).toHaveLength(60);
    expect(new Set(dataset.map((q) => q.id)).size).toBe(60);
  });

  it("holds out 15 questions, spread across every category", () => {
    const holdout = dataset.filter((q) => q.split === "holdout");
    expect(holdout).toHaveLength(15);
    for (const category of categories) {
      expect(holdout.some((q) => q.category === category)).toBe(true);
    }
  });

  it("gives every answerable question gold labels and an expected answer", () => {
    for (const q of dataset.filter((q) => q.category !== "out-of-scope")) {
      expect(q.gold.length, q.id).toBeGreaterThan(0);
      expect(q.expectedAnswer, q.id).toBeTruthy();
    }
  });

  it("keeps gold labels unique within a question", () => {
    for (const q of dataset) {
      const keys = q.gold.map((g) => `${g.path}::${g.heading ?? ""}`);
      expect(new Set(keys).size, q.id).toBe(keys.length);
    }
  });
});
