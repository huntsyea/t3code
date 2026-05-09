export interface TagMatch {
  readonly tag: string;
  readonly span?: readonly [number, number];
  readonly source: "inline" | "frontmatter";
}

const TAG_BODY_STICKY = /[a-zA-Z][a-zA-Z0-9_/-]*/y;
const TAG_BODY_FULL = /^[a-zA-Z][a-zA-Z0-9_/-]*$/;

function computeExclusionRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  const fenceRe = /(^|\n)([ \t]{0,3})(```+|~~~+)([^\n]*)\n/g;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRe.exec(content)) !== null) {
    const fenceChar = fenceMatch[3]![0]!;
    const fenceLen = fenceMatch[3]!.length;
    const blockStart = fenceMatch.index + fenceMatch[1]!.length;
    const afterOpen = fenceRe.lastIndex;
    const closeRe = new RegExp(`\\n[ \\t]{0,3}\\${fenceChar}{${fenceLen},}[ \\t]*(?:\\n|$)`, "g");
    closeRe.lastIndex = afterOpen;
    const closeMatch = closeRe.exec(content);
    const blockEnd = closeMatch ? closeMatch.index + closeMatch[0]!.length : content.length;
    ranges.push([blockStart, blockEnd]);
    fenceRe.lastIndex = blockEnd;
  }

  // Inline code: pair backtick runs of equal length, refusing to span blank lines.
  const backtickRe = /`+/g;
  const runs: Array<{ index: number; length: number }> = [];
  let bm: RegExpExecArray | null;
  while ((bm = backtickRe.exec(content)) !== null) {
    if (isInsideAny(ranges, bm.index)) continue;
    runs.push({ index: bm.index, length: bm[0]!.length });
  }
  const used = new Set<number>();
  for (let i = 0; i < runs.length; i += 1) {
    if (used.has(i)) continue;
    const open = runs[i]!;
    for (let j = i + 1; j < runs.length; j += 1) {
      if (used.has(j)) continue;
      const close = runs[j]!;
      if (close.length !== open.length) continue;
      const between = content.slice(open.index + open.length, close.index);
      if (/\n\s*\n/.test(between)) continue;
      ranges.push([open.index, close.index + close.length]);
      used.add(i);
      used.add(j);
      break;
    }
  }

  const urlRe = /\bhttps?:\/\/[^\s<>"')\]]+/g;
  let um: RegExpExecArray | null;
  while ((um = urlRe.exec(content)) !== null) {
    if (isInsideAny(ranges, um.index)) continue;
    ranges.push([um.index, um.index + um[0]!.length]);
  }

  ranges.sort((a, b) => a[0] - b[0]);
  return ranges;
}

function isInsideAny(ranges: ReadonlyArray<readonly [number, number]>, index: number): boolean {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true;
  }
  return false;
}

function findHeadingHashIndices(content: string): Set<number> {
  const indices = new Set<number>();
  // ATX headings: 1-6 `#` at line start followed by space or EOL.
  const headingRe = /(^|\n)(#{1,6})(?=[ \t]|$|\n)/g;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(content)) !== null) {
    const start = m.index + m[1]!.length;
    const hashes = m[2]!;
    for (let i = 0; i < hashes.length; i += 1) {
      indices.add(start + i);
    }
  }
  return indices;
}

function normalizeFrontmatterTag(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().replace(/^#/, "");
  if (trimmed.length === 0) return undefined;
  if (!TAG_BODY_FULL.test(trimmed)) return undefined;
  return trimmed.toLowerCase();
}

function extractFrontmatterTags(frontmatter: Record<string, unknown> | undefined): string[] {
  if (!frontmatter) return [];
  const raw = frontmatter["tags"];
  const collected: string[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const norm = normalizeFrontmatterTag(entry);
      if (norm !== undefined) collected.push(norm);
    }
  } else if (typeof raw === "string") {
    for (const piece of raw.split(",")) {
      const norm = normalizeFrontmatterTag(piece);
      if (norm !== undefined) collected.push(norm);
    }
  }
  return collected;
}

const HASH_CODE = 0x23;

function isWordishChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x2f ||
    code === 0x2d
  );
}

export function parseTags(content: string, frontmatter?: Record<string, unknown>): TagMatch[] {
  const exclusionRanges = computeExclusionRanges(content);
  const headingHashIndices = findHeadingHashIndices(content);

  const seen = new Set<string>();
  const results: TagMatch[] = [];

  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) !== HASH_CODE) continue;
    if (headingHashIndices.has(i)) continue;
    if (isInsideAny(exclusionRanges, i)) continue;

    if (i > 0 && isWordishChar(content.charCodeAt(i - 1))) continue;

    TAG_BODY_STICKY.lastIndex = i + 1;
    const m = TAG_BODY_STICKY.exec(content);
    if (!m || m.index !== i + 1) continue;

    const body = m[0]!;
    const end = i + 1 + body.length;
    const normalized = body.toLowerCase();

    if (seen.has(normalized)) {
      i = end - 1;
      continue;
    }
    seen.add(normalized);
    results.push({ tag: normalized, span: [i, end], source: "inline" });
    i = end - 1;
  }

  for (const tag of extractFrontmatterTags(frontmatter)) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    results.push({ tag, source: "frontmatter" });
  }

  return results;
}
