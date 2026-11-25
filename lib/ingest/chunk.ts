/**
 * Heading-aware chunking.
 *
 * 1. Split the cleaned body into sections at Markdown headings (outside code).
 * 2. Split each section into blocks: paragraphs, lists, tables, and code blocks.
 *    A code block is one block and is never split.
 * 3. Pack blocks into chunks of up to `maxTokens`. A section that is too small
 *    on its own is merged into the previous chunk when it fits.
 *
 * No overlap between chunks: every chunk carries its heading path and a
 * generated context sentence, which covers what overlap would otherwise add.
 */

export interface Chunk {
  ordinal: number;
  /** "Caching › use cache › Cache lifetimes" */
  headingPath: string;
  content: string;
  tokenCount: number;
}

export interface ChunkOptions {
  maxTokens?: number;
  /** Sections smaller than this are merged into the previous chunk when possible. */
  minTokens?: number;
}

export const HEADING_SEPARATOR = " › ";

/**
 * Approximate token count. Claude's and Voyage's tokenizers both average
 * roughly 3–4 characters per token on technical English; 3.5 errs on the side
 * of smaller chunks. Used only for sizing, never for billing.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

interface Section {
  path: string[];
  blocks: string[];
}

export function chunkDocument(
  title: string,
  body: string,
  { maxTokens = 500, minTokens = 120 }: ChunkOptions = {},
): Chunk[] {
  const sections = splitSections(title, body);
  const chunks: Omit<Chunk, "ordinal">[] = [];

  for (const section of sections) {
    const headingPath = section.path.join(HEADING_SEPARATOR);
    const sectionText = section.blocks.join("\n\n");
    const sectionTokens = estimateTokens(sectionText);
    const prev = chunks.at(-1);

    // Small section: append to the previous chunk if the result still fits.
    if (prev && sectionTokens < minTokens && prev.tokenCount + sectionTokens <= maxTokens) {
      prev.content += "\n\n" + sectionText;
      prev.tokenCount = estimateTokens(prev.content);
      continue;
    }

    let current: string[] = [];
    let currentTokens = 0;
    const flush = () => {
      if (!current.length) return;
      const content = current.join("\n\n");
      chunks.push({ headingPath, content, tokenCount: estimateTokens(content) });
      current = [];
      currentTokens = 0;
    };
    for (const block of section.blocks.flatMap((b) => splitTable(b, maxTokens))) {
      const tokens = estimateTokens(block);
      if (currentTokens > 0 && currentTokens + tokens > maxTokens) flush();
      current.push(block);
      currentTokens += tokens;
    }
    flush();
  }

  return chunks
    .filter((c) => c.content.trim() !== "")
    .map((c, ordinal) => ({ ...c, ordinal }));
}

/**
 * Splits a Markdown table that is larger than `maxTokens` into row groups,
 * repeating the header and separator rows so each part reads as a table.
 * Anything that is not a table is returned unchanged.
 */
export function splitTable(block: string, maxTokens: number): string[] {
  const lines = block.split("\n");
  const isTable =
    lines.length > 2 &&
    lines.every((l) => l.trimStart().startsWith("|")) &&
    /^\s*\|?\s*:?-{3,}/.test(lines[1]);
  if (!isTable || estimateTokens(block) <= maxTokens) return [block];

  const header = lines.slice(0, 2);
  const headerTokens = estimateTokens(header.join("\n"));
  const parts: string[] = [];
  let rows: string[] = [];
  let tokens = headerTokens;
  for (const row of lines.slice(2)) {
    const t = estimateTokens(row) + 1;
    if (rows.length && tokens + t > maxTokens) {
      parts.push([...header, ...rows].join("\n"));
      rows = [];
      tokens = headerTokens;
    }
    rows.push(row);
    tokens += t;
  }
  if (rows.length) parts.push([...header, ...rows].join("\n"));
  return parts;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;

/** Splits into sections at headings. The heading line stays in its section's content. */
export function splitSections(title: string, body: string): Section[] {
  const sections: Section[] = [];
  // stack[i] = heading text at depth i+2 (## is depth 2); the doc title is the root.
  const stack: string[] = [];
  let current: Section = { path: [title], blocks: [] };
  let paragraph: string[] = [];
  let fence: string | null = null;

  const endParagraph = () => {
    const text = paragraph.join("\n").trim();
    if (text) current.blocks.push(text);
    paragraph = [];
  };

  for (const line of body.split("\n")) {
    const f = line.match(FENCE);
    if (fence !== null) {
      paragraph.push(line);
      if (f && line.trim().startsWith(fence)) {
        fence = null;
        endParagraph(); // a code block is always its own block
      }
      continue;
    }
    if (f) {
      endParagraph();
      fence = f[1];
      paragraph.push(line);
      continue;
    }

    const h = line.match(HEADING);
    if (h) {
      endParagraph();
      if (current.blocks.length) sections.push(current);
      const depth = h[1].length;
      const text = stripInlineMarkdown(h[2]);
      if (depth <= 1) {
        stack.length = 0;
      } else {
        stack.length = Math.min(stack.length, depth - 2);
        stack[depth - 2] = text;
      }
      current = { path: [title, ...stack.filter(Boolean)], blocks: [line.trim()] };
      continue;
    }

    if (line.trim() === "") endParagraph();
    else paragraph.push(line);
  }
  endParagraph();
  if (current.blocks.length) sections.push(current);

  // Drop sections that are only a heading with nothing under it.
  return sections.filter((s) => s.blocks.some((b) => !HEADING.test(b)));
}

/**
 * Plain text of a heading: link text instead of links, no backticks or `*`
 * emphasis. Underscores stay, since they are part of API names (`unstable_cache`).
 */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim();
}
