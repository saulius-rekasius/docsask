/** Formatting shared by the /evals pages. */

export const CONFIG_LABELS: Record<string, string> = {
  vector: "Vector",
  keyword: "Keyword (BM25)",
  hybrid: "Hybrid (RRF)",
  "vector-rerank": "Vector + rerank",
  "hybrid-rerank": "Hybrid + rerank",
};

export const CATEGORY_LABELS: Record<string, string> = {
  factual: "Factual",
  multi: "Multi-passage",
  recent: "New in 16.3/16.4",
  version: "Version changes",
  "out-of-scope": "Out of scope",
};

export function pct(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(value) ? "—" : `${(value * 100).toFixed(1)}%`;
}
