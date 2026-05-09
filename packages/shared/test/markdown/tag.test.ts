import { describe, expect, it } from "vitest";

import { parseTags, type TagMatch } from "../../src/markdown/tag.ts";

function tags(matches: TagMatch[]): string[] {
  return matches.map((m) => m.tag);
}

describe("parseTags — inline matches", () => {
  it("matches simple inline tags and lowercases them", () => {
    const result = parseTags("hello #foo and #BAR");
    expect(tags(result)).toEqual(["foo", "bar"]);
    for (const m of result) {
      expect(m.source).toBe("inline");
      expect(m.span).toBeDefined();
    }
  });

  it("returns spans pointing at the leading # and end after the body", () => {
    const result = parseTags("x #foo y");
    expect(result).toHaveLength(1);
    const m = result[0]!;
    expect(m.span).toEqual([2, 6]);
  });

  it("matches nested parent/child tags", () => {
    const result = parseTags("#parent/child");
    expect(tags(result)).toEqual(["parent/child"]);
  });

  it("matches deeply nested tags", () => {
    const result = parseTags("see #a/b/c here");
    expect(tags(result)).toEqual(["a/b/c"]);
  });

  it("rejects digits-only tags", () => {
    expect(parseTags("#123")).toEqual([]);
    expect(parseTags("issue #42 and #abc")).toEqual([
      expect.objectContaining({ tag: "abc", source: "inline" }),
    ]);
  });

  it("rejects markdown headings", () => {
    expect(parseTags("# Title")).toEqual([]);
    expect(parseTags("## Heading two")).toEqual([]);
    expect(parseTags("###### deepest")).toEqual([]);
  });

  it("does not treat # alone as a tag", () => {
    expect(parseTags("# ")).toEqual([]);
    expect(parseTags("a # b")).toEqual([]);
  });

  it("does not match # glued to a preceding word character", () => {
    expect(parseTags("foo#bar")).toEqual([]);
    expect(parseTags("path/#tag")).toEqual([]);
  });

  it("matches headings inside paragraph text (not at line start)", () => {
    const result = parseTags("see\n#tag and");
    expect(tags(result)).toEqual(["tag"]);
  });

  it("supports underscore and hyphen in tag bodies", () => {
    const result = parseTags("#foo_bar and #baz-qux");
    expect(tags(result)).toEqual(["foo_bar", "baz-qux"]);
  });
});

describe("parseTags — exclusion zones", () => {
  it("ignores tags inside fenced code blocks (backtick fences)", () => {
    const md = ["```", "this #should not match", "```", "but #yes does"].join("\n");
    expect(tags(parseTags(md))).toEqual(["yes"]);
  });

  it("ignores tags inside fenced code blocks (tilde fences)", () => {
    const md = ["~~~", "#nope", "~~~", "#ok"].join("\n");
    expect(tags(parseTags(md))).toEqual(["ok"]);
  });

  it("ignores tags inside inline code spans", () => {
    expect(parseTags("text `#nope` here")).toEqual([]);
    expect(parseTags("text `#nope` and #ok")).toEqual([
      expect.objectContaining({ tag: "ok", source: "inline" }),
    ]);
  });

  it("ignores #anchor in URLs", () => {
    expect(parseTags("https://x.com/#anchor")).toEqual([]);
    expect(parseTags("see https://x.com/#anchor and #real")).toEqual([
      expect.objectContaining({ tag: "real", source: "inline" }),
    ]);
  });

  it("ignores tags inside http URLs", () => {
    expect(parseTags("http://a.b/c#x and after")).toEqual([]);
  });

  it("treats unclosed code fence as code through end of file", () => {
    const md = ["```", "#a", "#b"].join("\n");
    expect(parseTags(md)).toEqual([]);
  });
});

describe("parseTags — deduplication", () => {
  it("dedupes repeated inline occurrences", () => {
    const result = parseTags("#foo and #FOO and #Foo");
    expect(tags(result)).toEqual(["foo"]);
  });
});

describe("parseTags — frontmatter", () => {
  it("includes frontmatter tags from array form", () => {
    const result = parseTags("body", { tags: ["foo", "bar"] });
    expect(tags(result)).toEqual(["foo", "bar"]);
    for (const m of result) {
      expect(m.source).toBe("frontmatter");
      expect(m.span).toBeUndefined();
    }
  });

  it("includes frontmatter tags from comma-separated string form", () => {
    const result = parseTags("body", { tags: "foo, bar, baz" });
    expect(tags(result)).toEqual(["foo", "bar", "baz"]);
  });

  it("strips a leading # in frontmatter values", () => {
    const result = parseTags("body", { tags: ["#foo", "bar"] });
    expect(tags(result)).toEqual(["foo", "bar"]);
  });

  it("rejects malformed frontmatter entries", () => {
    const result = parseTags("body", { tags: ["123", "*bad", " ", 7, "good"] });
    expect(tags(result)).toEqual(["good"]);
  });

  it("merges inline + frontmatter and deduplicates", () => {
    const result = parseTags("hello #foo and #BAR", {
      tags: ["bar", "baz"],
    });
    expect(tags(result)).toEqual(["foo", "bar", "baz"]);
    expect(result[0]?.source).toBe("inline");
    expect(result[1]?.source).toBe("inline");
    expect(result[2]?.source).toBe("frontmatter");
  });

  it("ignores non-string frontmatter tag types", () => {
    const result = parseTags("body", { tags: 42 as unknown as string });
    expect(result).toEqual([]);
  });

  it("returns empty when frontmatter has no tags key", () => {
    const result = parseTags("body", { other: "value" });
    expect(result).toEqual([]);
  });
});
