import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { SignOutButton } from "./sign-out-button";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-12">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Greeting />
      </Suspense>
      <Card>
        <CardHeader>
          <CardTitle>
            <Link href="/search" className="hover:underline">
              Search the docs →
            </Link>
          </CardTitle>
          <CardDescription>
            Find the passages that answer a question, ranked by hybrid search and a reranker.
          </CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <Link href="/evals" className="hover:underline">
              Evaluation results →
            </Link>
          </CardTitle>
          <CardDescription>
            How well search finds the right passages on 60 labelled questions, per configuration.
          </CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>No conversations yet</CardTitle>
          <CardDescription>
            Chat with cited answers arrives once the Claude API is enabled.
          </CardDescription>
        </CardHeader>
      </Card>
    </main>
  );
}

/** Reads the session (request-time data), so it renders inside Suspense. */
async function Greeting() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in?next=/dashboard");

  return (
    <div className="flex items-center justify-between gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">
        Welcome, {session.user.name}
      </h1>
      <SignOutButton />
    </div>
  );
}
