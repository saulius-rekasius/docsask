import { describe, expect, it } from "vitest";
import {
  firstRelevantRank,
  meanScores,
  ndcgAtK,
  percentile,
  recallAtK,
  reciprocalRank,
  satisfies,
  scoreQuestion,
} from "@/lib/evals/metrics";

const chunk = (documentPath: string, headingPath: string) => ({ documentPath, headingPath });
const miss = chunk("other.md", "Other");

describe("satisfies", () => {
  const gold = { path: "a.md", heading: "A › Usage" };
  it("matches the heading itself and anything under it", () => {
    expect(satisfies(chunk("a.md", "A › Usage"), gold)).toBe(true);
    expect(satisfies(chunk("a.md", "A › Usage › Example"), gold)).toBe(true);
  });
  it("does not match a sibling whose name starts the same way", () => {
    expect(satisfies(chunk("a.md", "A › Usage notes"), gold)).toBe(false);
  });
  it("does not match another document", () => {
    expect(satisfies(chunk("b.md", "A › Usage"), gold)).toBe(false);
  });
  it("matches anywhere in the document when no heading is given", () => {
    expect(satisfies(chunk("a.md", "A › Anything"), { path: "a.md" })).toBe(true);
  });
});

describe("recallAtK", () => {
  const gold = [{ path: "a.md" }, { path: "b.md" }];
  it("counts each gold label once, even if several chunks satisfy it", () => {
    expect(recallAtK([chunk("a.md", "A"), chunk("a.md", "A › x"), miss], gold, 5)).toBe(0.5);
  });
  it("only looks at the top k", () => {
    expect(recallAtK([miss, miss, chunk("b.md", "B")], gold, 2)).toBe(0);
    expect(recallAtK([miss, chunk("a.md", "A"), chunk("b.md", "B")], gold, 3)).toBe(1);
  });
  it("is NaN without gold labels", () => {
    expect(recallAtK([miss], [], 5)).toBeNaN();
  });
});

describe("reciprocalRank", () => {
  it("is 1 / rank of the first relevant chunk", () => {
    expect(reciprocalRank([miss, miss, chunk("a.md", "A")], [{ path: "a.md" }])).toBeCloseTo(1 / 3);
  });
  it("is 0 when nothing relevant is in the top k", () => {
    expect(reciprocalRank([miss, chunk("a.md", "A")], [{ path: "a.md" }], 1)).toBe(0);
  });
});

describe("ndcgAtK", () => {
  const gold = [{ path: "a.md" }, { path: "b.md" }];
  it("is 1 for a perfect ranking", () => {
    expect(ndcgAtK([chunk("a.md", "A"), chunk("b.md", "B"), miss], gold, 5)).toBeCloseTo(1);
  });
  it("discounts relevant chunks found lower down", () => {
    const late = ndcgAtK([miss, chunk("a.md", "A"), chunk("b.md", "B")], gold, 5);
    expect(late).toBeGreaterThan(0);
    expect(late).toBeLessThan(1);
  });
  it("gives no extra credit for a second chunk of an already-found section", () => {
    expect(ndcgAtK([chunk("a.md", "A"), chunk("a.md", "A › x")], gold, 5)).toBeCloseTo(1 / (1 + 1 / Math.log2(3)));
  });
});

describe("scoreQuestion and meanScores", () => {
  it("reports hit@1 and skips questions without gold in the mean", () => {
    const hit = scoreQuestion([chunk("a.md", "A")], [{ path: "a.md" }]);
    const outOfScope = scoreQuestion([miss], []);
    expect(hit.hitAt1).toBe(1);
    const mean = meanScores([hit, outOfScope, scoreQuestion([miss], [{ path: "a.md" }])]);
    expect(mean.n).toBe(2);
    expect(mean.recallAt5).toBe(0.5);
  });
});

describe("firstRelevantRank and percentile", () => {
  it("returns the 1-based rank or undefined", () => {
    expect(firstRelevantRank([miss, chunk("a.md", "A")], [{ path: "a.md" }])).toBe(2);
    expect(firstRelevantRank([miss], [{ path: "a.md" }])).toBeUndefined();
  });
  it("uses nearest-rank percentiles", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 100], 95)).toBe(100);
  });
});

describe("alternative gold sections", () => {
  const gold = { path: "a.md", heading: "A › Usage", alt: [{ path: "guide.md", heading: "Guide › Cookies" }] };
  it("is satisfied by the main section or any alternative", () => {
    expect(satisfies(chunk("a.md", "A › Usage"), gold)).toBe(true);
    expect(satisfies(chunk("guide.md", "Guide › Cookies › Example"), gold)).toBe(true);
    expect(satisfies(chunk("guide.md", "Guide › Other"), gold)).toBe(false);
  });
  it("counts a label once even when both its main section and an alternative are retrieved", () => {
    expect(recallAtK([chunk("a.md", "A › Usage"), chunk("guide.md", "Guide › Cookies")], [gold], 5)).toBe(1);
  });
});
