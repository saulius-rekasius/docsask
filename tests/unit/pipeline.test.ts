import { describe, expect, it, vi } from "vitest";
import { retrieve, sectionUrl, slugify, type ChunkRecord, type RetrievalDeps } from "@/lib/retrieval/pipeline";

const record = (id: string, headingPath = `Doc › ${id}`): ChunkRecord => ({
  id,
  headingPath,
  content: `Content of ${id}`,
  context: null,
  documentTitle: "Doc",
  documentUrl: "https://nextjs.org/docs/app/doc",
  documentPath: "01-app/doc.md",
  section: "Guides",
});

function deps(overrides: Partial<RetrievalDeps> = {}): RetrievalDeps {
  return {
    embedQuery: vi.fn(async () => [0.1, 0.2]),
    vectorSearch: vi.fn(async () => ["a", "b", "c"]),
    keywordSearch: vi.fn(async () => ["c", "d"]),
    loadChunks: vi.fn(async (ids: string[]) => ids.map((id) => record(id))),
    // Reverse the candidates: proves the reranker's order wins over the fused order.
    rerank: vi.fn(async (_q: string, docs: string[], topK: number) =>
      docs.map((_, index) => ({ index, score: index / 10 })).reverse().slice(0, topK),
    ),
    ...overrides,
  };
}

describe("retrieve", () => {
  it("fuses vector and keyword results and records each signal", async () => {
    const { hits } = await retrieve("q", deps(), { rerank: false, topK: 4 });
    expect(hits[0].id).toBe("c"); // in both lists
    expect(hits[0]).toMatchObject({ vectorRank: 3, keywordRank: 1, fusedRank: 1 });
    expect(hits.map((h) => h.id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("orders the final results by rerank score", async () => {
    const d = deps();
    const result = await retrieve("q", d, { topK: 2 });
    expect(result.reranked).toBe(true);
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0].rerankScore).toBeGreaterThan(result.hits[1].rerankScore!);
    expect(d.rerank).toHaveBeenCalledWith("q", expect.any(Array), 2);
  });

  it("falls back to the fused order when reranking fails", async () => {
    const result = await retrieve(
      "q",
      deps({ rerank: vi.fn(async () => Promise.reject(new Error("429"))) }),
      { topK: 3 },
    );
    expect(result.reranked).toBe(false);
    expect(result.rerankError).toBe("429");
    expect(result.hits.map((h) => h.fusedRank)).toEqual([1, 2, 3]);
  });

  it("skips chunks that no longer exist", async () => {
    const result = await retrieve(
      "q",
      deps({ loadChunks: vi.fn(async (ids: string[]) => ids.filter((id) => id !== "c").map((id) => record(id))) }),
      { rerank: false },
    );
    expect(result.hits.map((h) => h.id)).not.toContain("c");
  });

  it("does not call the reranker when nothing matched", async () => {
    const d = deps({ vectorSearch: vi.fn(async () => []), keywordSearch: vi.fn(async () => []) });
    const result = await retrieve("q", d);
    expect(result.hits).toEqual([]);
    expect(d.rerank).not.toHaveBeenCalled();
  });

  it("sends the context, heading path and content to the reranker", async () => {
    const d = deps({
      loadChunks: vi.fn(async (ids: string[]) => ids.map((id) => ({ ...record(id), context: `Ctx ${id}.` }))),
    });
    await retrieve("q", d);
    const docs = vi.mocked(d.rerank).mock.calls[0][1];
    expect(docs[0]).toMatch(/^Ctx \w\.\n\nDoc › \w\n\nContent of \w$/);
  });
});

describe("sectionUrl", () => {
  it("links to the anchor of the last heading", () => {
    expect(sectionUrl("https://nextjs.org/docs/x", "use cache › Cache lifetimes")).toBe(
      "https://nextjs.org/docs/x#cache-lifetimes",
    );
  });

  it("links to the page itself for top-level chunks", () => {
    expect(sectionUrl("https://nextjs.org/docs/x", "use cache")).toBe("https://nextjs.org/docs/x");
  });
});

describe("slugify", () => {
  it.each([
    ["Cache lifetimes", "cache-lifetimes"],
    ["How `use cache: remote` differs", "how-use-cache-remote-differs"],
    ["Step 1: Install", "step-1-install"],
    ["Not available in `unstable_cache`", "not-available-in-unstable_cache"],
  ])("%s → %s", (heading, slug) => {
    expect(slugify(heading)).toBe(slug);
  });
});

describe("retrieve with a single retriever", () => {
  it("runs only vector search when asked", async () => {
    const d = deps();
    const { hits } = await retrieve("q", d, { retrievers: ["vector"], rerank: false });
    expect(d.keywordSearch).not.toHaveBeenCalled();
    expect(hits.map((h) => h.id)).toEqual(["a", "b", "c"]);
    expect(hits.every((h) => h.keywordRank === undefined)).toBe(true);
  });

  it("runs only keyword search, without embedding the query", async () => {
    const d = deps();
    const { hits } = await retrieve("q", d, { retrievers: ["keyword"], rerank: false });
    expect(d.embedQuery).not.toHaveBeenCalled();
    expect(hits.map((h) => h.id)).toEqual(["c", "d"]);
  });
});
