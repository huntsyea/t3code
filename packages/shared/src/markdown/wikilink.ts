/**
 * Pure parser for `[[basename]]` wikilinks in markdown.
 *
 * Basenames only — does NOT match `[[Note#H]]`, `[[Note^id]]`,
 * `[[Note|alias]]`, or `![[Note]]` (transclusion). Path resolution is
 * intentionally out of scope.
 *
 * Wikilinks inside fenced code blocks, inline code, YAML frontmatter, or
 * HTML comments are excluded.
 */

export interface WikilinkMatch {
  basename: string;
  /** `[start, end]` character offsets of the full `[[basename]]` token. */
  span: [number, number];
  rawText: string;
}

type ExclusionZone = readonly [number, number];

const CHAR_OPEN_BRACKET = 0x5b;
const CHAR_CLOSE_BRACKET = 0x5d;
const CHAR_BANG = 0x21;

// Disallow `[`, `]`, `|`, newlines, `#`, `^` in basenames.
const BASENAME_CHAR_REGEX = /[^[\]|\n#^]/;

function detectFrontmatterZone(content: string): ExclusionZone | null {
  if (!content.startsWith("---")) {
    return null;
  }
  const afterOpening = content.indexOf("\n");
  if (afterOpening < 0) {
    return null;
  }
  const openingLine = content.slice(0, afterOpening).trimEnd();
  if (openingLine !== "---") {
    return null;
  }
  const closingPattern = /\n---[ \t]*(?:\n|$)/;
  const match = closingPattern.exec(content.slice(afterOpening));
  if (!match) {
    return null;
  }
  const closingStart = afterOpening + match.index;
  const closingEnd = closingStart + match[0].length;
  return [0, closingEnd] as const;
}

function detectFencedCodeZones(content: string): ExclusionZone[] {
  const zones: ExclusionZone[] = [];
  // Opening fence on its own line: 3+ backticks or 3+ tildes.
  const fencePattern = /(^|\n)(```+|~~~+)([^\n]*)(?:\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(content)) !== null) {
    const leadingNewline = match[1] ?? "";
    const fence = match[2] ?? "";
    const blockStart = match.index + leadingNewline.length;
    const closingChar = fence[0];
    // Closing fence: same char, length >= opening length, on its own line.
    const escapedChar = closingChar === "`" ? "`" : "~";
    const closingPattern = new RegExp(`\\n(${escapedChar}{${fence.length},})[ \\t]*(?=\\n|$)`, "g");
    closingPattern.lastIndex = match.index + match[0].length;
    const closing = closingPattern.exec(content);
    const blockEnd = closing ? closing.index + closing[0].length : content.length;
    zones.push([blockStart, blockEnd] as const);
    fencePattern.lastIndex = blockEnd;
  }
  return zones;
}

function detectInlineCodeZones(content: string): ExclusionZone[] {
  const zones: ExclusionZone[] = [];
  const runPattern = /`+/g;
  let openMatch: RegExpExecArray | null;
  while ((openMatch = runPattern.exec(content)) !== null) {
    const openRun = openMatch[0];
    const openStart = openMatch.index;
    const closingPattern = new RegExp(`\`{${openRun.length}}(?!\`)`, "g");
    closingPattern.lastIndex = openStart + openRun.length;
    const closeMatch = closingPattern.exec(content);
    if (!closeMatch) {
      runPattern.lastIndex = openStart + openRun.length;
      continue;
    }
    // Conservative: inline code never crosses a blank line.
    const between = content.slice(openStart + openRun.length, closeMatch.index);
    if (between.includes("\n\n")) {
      runPattern.lastIndex = openStart + openRun.length;
      continue;
    }
    const end = closeMatch.index + closeMatch[0].length;
    zones.push([openStart, end] as const);
    runPattern.lastIndex = end;
  }
  return zones;
}

function detectHtmlCommentZones(content: string): ExclusionZone[] {
  const zones: ExclusionZone[] = [];
  const pattern = /<!--[\s\S]*?-->/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    zones.push([match.index, match.index + match[0].length] as const);
  }
  return zones;
}

function mergeZones(zones: ExclusionZone[]): ExclusionZone[] {
  if (zones.length === 0) {
    return [];
  }
  const sorted = zones.toSorted((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      if (end > last[1]) {
        last[1] = end;
      }
    } else {
      merged.push([start, end]);
    }
  }
  return merged.map(([s, e]) => [s, e] as const);
}

function computeExclusionZones(content: string): ExclusionZone[] {
  const zones: ExclusionZone[] = [];
  const frontmatter = detectFrontmatterZone(content);
  if (frontmatter) {
    zones.push(frontmatter);
  }
  zones.push(...detectFencedCodeZones(content));
  zones.push(...detectInlineCodeZones(content));
  zones.push(...detectHtmlCommentZones(content));
  return mergeZones(zones);
}

function isOffsetExcluded(offset: number, zones: readonly ExclusionZone[]): boolean {
  for (const [start, end] of zones) {
    if (offset >= end) {
      continue;
    }
    return offset >= start;
  }
  return false;
}

function tryExtractWikilinkAt(content: string, start: number): WikilinkMatch | null {
  if (content.charCodeAt(start) !== CHAR_OPEN_BRACKET) {
    return null;
  }
  if (content.charCodeAt(start + 1) !== CHAR_OPEN_BRACKET) {
    return null;
  }
  // Reject transclusion `![[...]]`.
  if (start > 0 && content.charCodeAt(start - 1) === CHAR_BANG) {
    return null;
  }

  let cursor = start + 2;
  const basenameStart = cursor;
  while (cursor < content.length && BASENAME_CHAR_REGEX.test(content[cursor]!)) {
    cursor += 1;
  }

  if (cursor === basenameStart) {
    return null;
  }
  if (
    cursor + 1 >= content.length ||
    content.charCodeAt(cursor) !== CHAR_CLOSE_BRACKET ||
    content.charCodeAt(cursor + 1) !== CHAR_CLOSE_BRACKET
  ) {
    return null;
  }

  const end = cursor + 2;
  const basename = content.slice(basenameStart, cursor);
  return {
    basename,
    span: [start, end],
    rawText: content.slice(start, end),
  };
}

/**
 * Find all wikilinks in `content`, skipping frontmatter, fenced code,
 * inline code, and HTML comments.
 */
export function parseWikilinks(content: string): WikilinkMatch[] {
  const zones = computeExclusionZones(content);
  const matches: WikilinkMatch[] = [];

  let index = 0;
  while (index < content.length) {
    if (isOffsetExcluded(index, zones)) {
      index += 1;
      continue;
    }
    if (content.charCodeAt(index) === CHAR_OPEN_BRACKET) {
      const candidate = tryExtractWikilinkAt(content, index);
      if (candidate) {
        matches.push(candidate);
        index = candidate.span[1];
        continue;
      }
    }
    index += 1;
  }

  return matches;
}

/**
 * Return the wikilink containing `offset` (inclusive of both endpoints), or
 * `null`. The inclusive-end behaviour lets callers use the caret position
 * after a closing `]]` to still resolve the wikilink.
 */
export function isWikilinkAt(content: string, offset: number): WikilinkMatch | null {
  if (offset < 0 || offset > content.length) {
    return null;
  }
  const matches = parseWikilinks(content);
  for (const match of matches) {
    const [start, end] = match.span;
    if (offset >= start && offset <= end) {
      return match;
    }
  }
  return null;
}
