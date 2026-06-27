/**
 * Markdown-aware chunker for the RAG ingestion pipeline.
 *
 * Splits a document into one chunk per heading section, tagged with the full
 * heading path (`A > B > C`) so retrieved chunks can be cited precisely. Oversized
 * sections are split further by paragraph; tiny sections stay separate to keep
 * citations granular. See docs/RAG_PLAN.md §5.
 */

export interface ChunkMeta {
  source: string;
  repo?: string;
}

export interface Chunk {
  text: string;
  source: string;
  repo?: string;
  heading: string;
  index: number;
}

interface Section {
  heading: string;
  body: string;
}

/** Rough token estimate: ~4 chars per token. Good enough for sizing chunks. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;

/** Parse markdown into heading sections with full heading paths. */
function parseSections(doc: string): Section[] {
  const lines = doc.split(/\r?\n/);
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let body: string[] = [];

  const flush = () => {
    const text = body.join("\n").trim();
    if (text) sections.push({ heading: stack.map((s) => s.title).join(" > "), body: text });
    body = [];
  };

  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      flush();
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: m[2].trim() });
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

export interface ChunkOptions {
  maxTokens?: number;
  overlapTokens?: number;
}

const DEFAULTS = { maxTokens: 800, overlapTokens: 60 };

/** Greedily pack `units` (paragraphs/sentences) into parts no larger than maxTokens. */
function packUnits(units: string[], maxTokens: number): string[] {
  const parts: string[] = [];
  let cur = "";
  for (const u of units) {
    const candidate = cur ? `${cur}\n\n${u}` : u;
    if (cur && estimateTokens(candidate) > maxTokens) {
      parts.push(cur);
      cur = u;
    } else {
      cur = candidate;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

/** Prepend the tail of each previous part to the next so context spanning a split survives. */
function withOverlap(parts: string[], overlapTokens: number): string[] {
  if (parts.length < 2 || overlapTokens <= 0) return parts;
  const n = overlapTokens * 4; // chars ≈ tokens * 4
  return parts.map((p, i) => (i === 0 ? p : `${parts[i - 1].slice(-n).trimStart()}\n${p}`));
}

/** Split one section body into parts each <= maxTokens (by paragraph, then sentence). */
function splitBody(body: string, maxTokens: number, overlapTokens: number): string[] {
  if (estimateTokens(body) <= maxTokens) return [body];
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const units: string[] = [];
  for (const p of paragraphs) {
    if (estimateTokens(p) <= maxTokens) units.push(p);
    else units.push(...(p.match(/[^.!?]+[.!?]*\s*/g) ?? [p]).map((s) => s.trim()).filter(Boolean));
  }
  return withOverlap(packUnits(units, maxTokens), overlapTokens);
}

export function chunkMarkdown(doc: string, meta: ChunkMeta, opts: ChunkOptions = {}): Chunk[] {
  const maxTokens = opts.maxTokens ?? DEFAULTS.maxTokens;
  const overlapTokens = opts.overlapTokens ?? DEFAULTS.overlapTokens;
  const sections = parseSections(doc);
  const chunks: Chunk[] = [];
  let index = 0;
  for (const s of sections) {
    for (const part of splitBody(s.body, maxTokens, overlapTokens)) {
      chunks.push({
        text: part,
        source: meta.source,
        repo: meta.repo,
        heading: s.heading,
        index: index++,
      });
    }
  }
  return chunks;
}
