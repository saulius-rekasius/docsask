import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { latestRuns, type MetricSummary, type RunRow } from "@/lib/evals/queries";
import { CATEGORY_LABELS, CONFIG_LABELS, pct } from "./format";

export const metadata: Metadata = { title: "Evaluation" };

const METRICS: { key: keyof Omit<MetricSummary, "n">; label: string; hint: string }[] = [
  { key: "recallAt5", label: "Recall@5", hint: "Share of required passages found in the top 5" },
  { key: "mrr", label: "MRR", hint: "1 / rank of the first relevant passage, averaged" },
  { key: "hitAt1", label: "Hit@1", hint: "Questions whose first result is relevant" },
  { key: "ndcgAt5", label: "nDCG@5", hint: "Ranking quality of the top 5" },
];

export default function EvalsPage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-12">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Retrieval evaluation</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          60 hand-written questions about the Next.js 16 docs, each labelled with the sections that answer it.
          Configurations are tuned on the dev split (45); the held-out split (15) is run once for the headline
          numbers. Out-of-scope questions are excluded from these metrics.
        </p>
      </div>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading results…</p>}>
        <Results />
      </Suspense>
    </main>
  );
}

async function Results() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in?next=/evals");

  const runs = await latestRuns();
  if (runs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No runs yet. Run <code className="font-mono">npm run eval</code> to create one.
      </p>
    );
  }

  return (
    <>
      {(["holdout", "dev"] as const).map((split) => {
        const splitRuns = runs.filter((r) => r.split === split);
        return splitRuns.length ? <SplitResults key={split} split={split} runs={splitRuns} /> : null;
      })}
    </>
  );
}

function SplitResults({ split, runs }: { split: "dev" | "holdout"; runs: RunRow[] }) {
  const best = Math.max(...runs.map((r) => r.summary.overall.recallAt5 ?? 0));
  const categories = Object.keys(runs[0].summary.byCategory);
  const latest = runs.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{split === "holdout" ? "Held-out split (headline)" : "Dev split"}</CardTitle>
        <CardDescription>
          {runs[0].summary.overall.n} answerable questions · git {latest.gitSha ?? "unknown"} ·{" "}
          {latest.createdAt.toISOString().slice(0, 10)}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-4 font-medium">Configuration</th>
                {METRICS.map((m) => (
                  <th key={m.key} className="py-2 pr-4 font-medium" title={m.hint}>
                    {m.label}
                  </th>
                ))}
                <th className="py-2 pr-4 font-medium" title="Median and 95th percentile latency per query">
                  p50 / p95
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const o = run.summary.overall;
                return (
                  <tr key={run.id} className="border-b last:border-0">
                    <td className="py-2 pr-4">
                      <Link href={`/evals/${run.id}`} className="font-medium hover:underline">
                        {CONFIG_LABELS[run.configName] ?? run.configName}
                      </Link>
                    </td>
                    {METRICS.map((m) => (
                      <td key={m.key} className="py-2 pr-4 tabular-nums">
                        <span className={m.key === "recallAt5" && o.recallAt5 === best ? "font-semibold" : undefined}>
                          {pct(o[m.key])}
                        </span>
                        {m.key === "recallAt5" && <Bar value={o.recallAt5} />}
                      </td>
                    ))}
                    <td className="py-2 pr-4 tabular-nums text-muted-foreground">
                      {run.summary.latencyMs.p50} / {run.summary.latencyMs.p95} ms
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="overflow-x-auto">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Recall@5 by question category</p>
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-4 font-medium">Configuration</th>
                {categories.map((c) => (
                  <th key={c} className="py-2 pr-4 font-medium">
                    {CATEGORY_LABELS[c] ?? c} ({runs[0].summary.byCategory[c].n})
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-b last:border-0">
                  <td className="py-2 pr-4">{CONFIG_LABELS[run.configName] ?? run.configName}</td>
                  {categories.map((c) => (
                    <td key={c} className="py-2 pr-4 tabular-nums">
                      {pct(run.summary.byCategory[c].recallAt5)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function Bar({ value }: { value: number | null }) {
  return (
    <span aria-hidden className="mt-1 block h-1 w-24 overflow-hidden rounded-full bg-muted">
      <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.round((value ?? 0) * 100)}%` }} />
    </span>
  );
}
