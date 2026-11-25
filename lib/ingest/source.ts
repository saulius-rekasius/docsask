import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * Next.js ships its docs inside the package (node_modules/next/dist/docs), so
 * the corpus always matches the installed version and needs no network fetch.
 */
export const DOCS_ROOT = join(process.cwd(), "node_modules", "next", "dist", "docs");

/**
 * Part of every document's checksum. Bump it when parsing or chunking changes,
 * so the next ingest re-processes documents whose files did not change.
 */
export const PIPELINE_VERSION = 2;

/** App Router docs plus the router-independent sections. Pages Router is legacy. */
const INCLUDED_TOP_LEVEL = ["01-app", "03-architecture", "04-community"];

export interface SourceFile {
  /** Path relative to the docs root, with forward slashes, e.g. "01-app/02-guides/caching.md". */
  path: string;
  raw: string;
  checksum: string;
  url: string;
  section: string;
}

export async function listSourceFiles(root = DOCS_ROOT): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  for (const top of INCLUDED_TOP_LEVEL) {
    for (const abs of await walk(join(root, top))) {
      if (!abs.endsWith(".md") && !abs.endsWith(".mdx")) continue;
      const path = relative(root, abs).split(sep).join("/");
      const raw = await readFile(abs, "utf8");
      files.push({
        path,
        raw,
        checksum: createHash("sha256").update(`pipeline:${PIPELINE_VERSION}
`).update(raw).digest("hex"),
        url: docsUrl(path),
        section: sectionOf(path),
      });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])),
  );
  return nested.flat();
}

/** Strips the "01-" ordering prefixes the docs repo uses for sidebar order. */
const stripOrder = (segment: string) => segment.replace(/^\d+-/, "");

/** "01-app/03-api-reference/01-directives/use-cache.md" → https://nextjs.org/docs/app/api-reference/directives/use-cache */
export function docsUrl(path: string): string {
  const segments = path
    .replace(/\.mdx?$/, "")
    .split("/")
    .map(stripOrder);
  if (segments.at(-1) === "index") segments.pop();
  return ["https://nextjs.org/docs", ...segments].join("/");
}

/** "01-app/02-guides/caching.md" → "Guides"; top-level files fall back to their area. */
export function sectionOf(path: string): string {
  const segments = path.split("/").map(stripOrder);
  const name = segments.length > 2 ? segments[1] : segments[0];
  return name
    .replace(/\.mdx?$/, "")
    .split("-")
    .map((w) => (w === "api" ? "API" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}
