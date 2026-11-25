import { describe, expect, it } from "vitest";
import { chunkDocument, estimateTokens, splitSections, splitTable, stripInlineMarkdown } from "@/lib/ingest/chunk";

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

describe("splitSections", () => {
  it("builds heading paths from nested headings", () => {
    const sections = splitSections(
      "Caching",
      "Intro.\n\n## use cache\n\nA.\n\n### Cache lifetimes\n\nB.\n\n## Revalidation\n\nC.",
    );
    expect(sections.map((s) => s.path.join(" › "))).toEqual([
      "Caching",
      "Caching › use cache",
      "Caching › use cache › Cache lifetimes",
      "Caching › Revalidation",
    ]);
  });

  it("strips links and code formatting from heading text", () => {
    const [, section] = splitSections("T", "Intro\n\n## The [`cacheLife`](/docs/x) function\n\nBody");
    expect(section.path).toEqual(["T", "The cacheLife function"]);
  });

  it("ignores headings inside code blocks", () => {
    const sections = splitSections("T", "Intro\n\n```bash\n# not a heading\n```");
    expect(sections).toHaveLength(1);
    expect(sections[0].blocks[1]).toBe("```bash\n# not a heading\n```");
  });

  it("keeps a code block with blank lines as a single block", () => {
    const [section] = splitSections("T", "```ts\nconst a = 1\n\nconst b = 2\n```");
    expect(section.blocks).toEqual(["```ts\nconst a = 1\n\nconst b = 2\n```"]);
  });

  it("drops headings that have no content under them", () => {
    const sections = splitSections("T", "## Empty\n\n## Full\n\nText");
    expect(sections.map((s) => s.path.at(-1))).toEqual(["Full"]);
  });
});

describe("chunkDocument", () => {
  it("returns no chunks for an empty document", () => {
    expect(chunkDocument("Empty", "")).toEqual([]);
    expect(chunkDocument("Empty", "\n\n  \n")).toEqual([]);
  });

  it("splits a long section into chunks under the limit, numbered in order", () => {
    const body = Array.from({ length: 10 }, () => words(60)).join("\n\n");
    const chunks = chunkDocument("T", body, { maxTokens: 300 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(300);
  });

  it("never splits a code block, even when it is larger than the limit", () => {
    const code = "```ts\n" + Array.from({ length: 200 }, (_, i) => `const v${i} = ${i}`).join("\n") + "\n```";
    const chunks = chunkDocument("T", `Intro.\n\n${code}\n\nOutro.`, { maxTokens: 200 });
    const holder = chunks.filter((c) => c.content.includes("const v0"));
    expect(holder).toHaveLength(1);
    expect(holder[0].content).toContain(code);
  });

  it("starts a new chunk at each heading", () => {
    const body = `${words(100)}\n\n## Second\n\n${words(100)}`;
    const chunks = chunkDocument("T", body, { maxTokens: 500, minTokens: 10 });
    expect(chunks.map((c) => c.headingPath)).toEqual(["T", "T › Second"]);
    expect(chunks[1].content.startsWith("## Second")).toBe(true);
  });

  it("merges a tiny section into the previous chunk when it fits", () => {
    const chunks = chunkDocument("T", `${words(50)}\n\n## Note\n\nShort.`, { maxTokens: 500, minTokens: 50 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("## Note\n\nShort.");
  });

  it("splits oversized tables into parts that each repeat the header", () => {
    const table = ["| API | Notes |", "| --- | --- |", ...Array.from({ length: 80 }, (_, i) => `| api${i} | ${words(8)} |`)].join("\n");
    const chunks = chunkDocument("T", table, { maxTokens: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.startsWith("| API | Notes |\n| --- | --- |")).toBe(true);
    const rows = chunks.flatMap((c) => c.content.split("\n").slice(2));
    expect(rows).toHaveLength(80);
  });
});

describe("splitTable", () => {
  it("leaves small tables and non-tables alone", () => {
    expect(splitTable("| a |\n| - |\n| 1 |", 500)).toHaveLength(1);
    expect(splitTable(words(500), 50)).toEqual([words(500)]);
  });
});

describe("estimateTokens", () => {
  it("is roughly chars / 3.5, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcdefg")).toBe(2);
  });
});

describe("stripInlineMarkdown", () => {
  it("keeps underscores that belong to API names", () => {
    expect(stripInlineMarkdown("Not available in `unstable_cache`")).toBe("Not available in unstable_cache");
    expect(stripInlineMarkdown("**Bold** and [`experimental_ppr`](/docs/x)")).toBe("Bold and experimental_ppr");
  });
});
