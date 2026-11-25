import "server-only";
import { db } from "../db/client";
import { env } from "../env";
import { retrieve, type RetrievalOptions } from "./pipeline";
import { createPostgresDeps } from "./postgres";

/** Retrieval for the app: the shared Postgres + Voyage deps with the app's database client. */

const deps = createPostgresDeps(db, () => {
  if (!env.VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY is not set");
  return env.VOYAGE_API_KEY;
});

export function search(query: string, options?: RetrievalOptions) {
  return retrieve(query, deps, options);
}

export type { Hit, RetrievalResult } from "./pipeline";
