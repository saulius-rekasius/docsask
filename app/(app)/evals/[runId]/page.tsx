import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { auth } from "@/lib/auth";
import { runWithResults } from "@/lib/evals/queries";
import { CATEGORY_LABELS, CONFIG_LABELS, pct } from "../format";

export const metadata: Metadata = { title: "Evaluation run" };

export default function RunPage({ params }: PageProps<"/evals/[runId]">) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-12">
      <Link href="/evals" className="text-sm text-muted-foreground hover:underline">
        ← All results
      </Link>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading run…</p>}>
        {params.then(({ runId }) => (
          <Run runId={runId} />
        ))}
      </Suspense>
    </main>
  );
}

async function Run({ runId }: { runId: string }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect(`/sign-in?next=/evals/${runId}`);
  if (!z.uuid().safeParse(runId).success) notFound();

  const data = await runWithResults(runId);
  if (!data) notFound();
  const { run, results } = data;
  const answerable = results.filter((r) => r.category !== "out-of-scope");

  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {CONFIG_LABELS[run.configName] ?? run.configName} · {run.split ?? "all"} split
        </h1>
        <p className="text-sm text-muted-foreground">
          Recall@5 {pct(run.summary?.overall.recallAt5)} · MRR {pct(run.summary?.overall.mrr)} · git{" "}
          {run.gitSha ?? "unknown"} · {run.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC
        </p>
      </div>

      <p className="text-sm text-muted-foreground">
        Each row shows the top 5 retrieved passages; relevant ones are marked ✓. Misses first.
      </p>
      <ol className="flex flex-col gap-3">
        {[...answerable]
          .sort((a, b) => (a.recallAt5 ?? 1) - (b.recallAt5 ?? 1) || a.slug.localeCompare(b.slug))
          .map((r) => (
            <li key={r.slug} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant={r.recallAt5 === 1 ? "secondary" : "destructive"}>R@5 {pct(r.recallAt5)}</Badge>
                <Badge variant="outline">{CATEGORY_LABELS[r.category] ?? r.category}</Badge>
                <span className="font-mono">{r.slug}</span>
                <span>first relevant: {r.firstRelevantRank ? `#${r.firstRelevantRank}` : "not in top 10"}</span>
              </div>
              <p className="mt-2 text-sm font-medium">{r.question}</p>
              <ul className="mt-2 flex flex-col gap-1 text-xs">
                {(r.retrieved ?? []).slice(0, 5).map((hit, i) => (
                  <li key={hit.chunkId} className="flex gap-2">
                    <span className="w-4 shrink-0 tabular-nums text-muted-foreground">{i + 1}</span>
                    <span className={hit.relevant ? "text-foreground" : "text-muted-foreground"}>
                      {hit.relevant ? "✓ " : ""}
                      <a href={hit.url} target="_blank" rel="noreferrer" className="hover:underline">
                        {hit.headingPath}
                      </a>
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
      </ol>
    </>
  );
}
