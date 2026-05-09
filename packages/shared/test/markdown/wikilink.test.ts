import { describe, expect, it } from "vitest";

import { isWikilinkAt, parseWikilinks } from "../../src/markdown/wikilink.ts";

describe("parseWikilinks", () => {
  it("matches a single wikilink", () => {
    const matches = parseWikilinks("hello [[world]]");
    expect(matches).toEqual([{ basename: "world", span: [6, 15], rawText: "[[world]]" }]);
  });

  it("matches multiple wikilinks", () => {
    const matches = parseWikilinks("[[a]] and [[b]]");
    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({ basename: "a", span: [0, 5], rawText: "[[a]]" });
    expect(matches[1]).toEqual({ basename: "b", span: [10, 15], rawText: "[[b]]" });
  });

  it("matches basenames containing spaces", () => {
    const matches = parseWikilinks("[[name with spaces]]");
    expect(matches).toEqual([
      { basename: "name with spaces", span: [0, 20], rawText: "[[name with spaces]]" },
    ]);
  });

  it("rejects transclusion ![[...]]", () => {
    expect(parseWikilinks("![[transclusion]]")).toEqual([]);
  });

  it("rejects heading anchors [[Note#Heading]]", () => {
    expect(parseWikilinks("[[Note#Heading]]")).toEqual([]);
  });

  it("rejects aliases [[Note|alias]]", () => {
    expect(parseWikilinks("[[Note|alias]]")).toEqual([]);
  });

  it("rejects block refs [[Note^id]]", () => {
    expect(parseWikilinks("[[Note^block]]")).toEqual([]);
  });

  it("rejects empty wikilinks [[]]", () => {
    expect(parseWikilinks("[[]]")).toEqual([]);
  });

  it("rejects nested brackets", () => {
    expect(parseWikilinks("[[a[b]]")).toEqual([]);
  });

  it("rejects unterminated wikilinks", () => {
    expect(parseWikilinks("[[unterminated")).toEqual([]);
  });

  it("ignores wikilinks inside fenced code blocks", () => {
    const content = "before\n```\n[[inside]]\n```\nafter [[outside]]";
    const matches = parseWikilinks(content);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.basename).toBe("outside");
  });

  it("ignores wikilinks inside tilde fenced code blocks", () => {
    const content = "~~~\n[[inside]]\n~~~\n[[outside]]";
    const matches = parseWikilinks(content);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.basename).toBe("outside");
  });

  it("ignores wikilinks inside inline code", () => {
    const content = "before `[[inside]]` after [[outside]]";
    const matches = parseWikilinks(content);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.basename).toBe("outside");
  });

  it("ignores wikilinks inside double-backtick inline code", () => {
    const content = "``[[inside]]`` and [[outside]]";
    const matches = parseWikilinks(content);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.basename).toBe("outside");
  });

  it("ignores wikilinks inside YAML frontmatter", () => {
    const content = "---\ntitle: [[inside]]\n---\n\n[[outside]]";
    const matches = parseWikilinks(content);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.basename).toBe("outside");
  });

  it("does not treat --- as frontmatter when not at file start", () => {
    const content = "intro\n---\nnot frontmatter\n---\n[[link]]";
    const matches = parseWikilinks(content);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.basename).toBe("link");
  });

  it("ignores wikilinks inside HTML comments", () => {
    const content = "<!-- [[hidden]] --> visible [[shown]]";
    const matches = parseWikilinks(content);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.basename).toBe("shown");
  });

  it("handles multi-line HTML comments", () => {
    const content = "<!--\n[[hidden]]\nstill hidden\n-->\n[[shown]]";
    const matches = parseWikilinks(content);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.basename).toBe("shown");
  });

  it("matches wikilinks adjacent to punctuation", () => {
    const matches = parseWikilinks("see [[Note]], also [[Other]]!");
    expect(matches.map((m) => m.basename)).toEqual(["Note", "Other"]);
  });

  it("matches across multiple lines", () => {
    const content = "line one [[a]]\nline two [[b]]\nline three [[c]]";
    const matches = parseWikilinks(content);
    expect(matches.map((m) => m.basename)).toEqual(["a", "b", "c"]);
  });

  it("returns spans that exactly cover the [[...]] token", () => {
    const content = "before [[target]] after";
    const [match] = parseWikilinks(content);
    expect(match).toBeDefined();
    expect(content.slice(match!.span[0], match!.span[1])).toBe("[[target]]");
    expect(match!.rawText).toBe("[[target]]");
  });

  it("returns empty array for empty content", () => {
    expect(parseWikilinks("")).toEqual([]);
  });

  it("returns empty array for content with no wikilinks", () => {
    expect(parseWikilinks("just plain text")).toEqual([]);
  });
});

describe("isWikilinkAt", () => {
  it("returns the match when offset is inside the basename", () => {
    const content = "before [[target]] after";
    const match = isWikilinkAt(content, 10);
    expect(match?.basename).toBe("target");
  });

  it("returns the match when offset is at the start bracket", () => {
    const content = "before [[target]] after";
    const match = isWikilinkAt(content, 7);
    expect(match?.basename).toBe("target");
  });

  it("returns the match when offset is at the end bracket (caret-after)", () => {
    const content = "[[target]]";
    const match = isWikilinkAt(content, 10);
    expect(match?.basename).toBe("target");
  });

  it("returns null when offset is outside any wikilink", () => {
    const content = "before [[target]] after";
    expect(isWikilinkAt(content, 0)).toBeNull();
    expect(isWikilinkAt(content, 5)).toBeNull();
    expect(isWikilinkAt(content, 20)).toBeNull();
  });

  it("returns null for negative or out-of-range offsets", () => {
    const content = "[[target]]";
    expect(isWikilinkAt(content, -1)).toBeNull();
    expect(isWikilinkAt(content, content.length + 1)).toBeNull();
  });

  it("returns null when offset is inside an excluded zone", () => {
    const content = "`[[inside]]`";
    expect(isWikilinkAt(content, 5)).toBeNull();
  });

  it("picks the correct match when multiple wikilinks exist", () => {
    const content = "[[a]] and [[b]]";
    expect(isWikilinkAt(content, 2)?.basename).toBe("a");
    expect(isWikilinkAt(content, 12)?.basename).toBe("b");
  });
});
