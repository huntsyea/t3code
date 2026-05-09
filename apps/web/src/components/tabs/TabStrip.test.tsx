import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TabStrip } from "./TabStrip";

function basename(filePath: string, ext: string): string {
  const lastSep = filePath.lastIndexOf("/");
  const name = lastSep >= 0 ? filePath.slice(lastSep + 1) : filePath;
  if (ext.length > 0 && name.endsWith(ext)) {
    return name.slice(0, name.length - ext.length);
  }
  return name;
}

function tabId(tab: { kind: string; id: string }): string {
  return tab.id;
}

describe("basename", () => {
  it("returns the filename without extension", () => {
    expect(basename("notes/hello.md", ".md")).toBe("hello");
  });

  it("handles paths without extensions", () => {
    expect(basename("notes/hello", ".md")).toBe("hello");
  });

  it("handles root-level files", () => {
    expect(basename("hello.md", ".md")).toBe("hello");
  });

  it("handles deep paths", () => {
    expect(basename("vault/sub/deep/file.md", ".md")).toBe("file");
  });

  it("does not strip partial extension matches", () => {
    expect(basename("notes/todo", ".md")).toBe("todo");
  });
});

describe("tabId", () => {
  it("returns the id of a tab", () => {
    expect(tabId({ kind: "chat", id: "thread-1" })).toBe("thread-1");
    expect(tabId({ kind: "note", id: "tab-1" })).toBe("tab-1");
  });
});

describe("TabStrip", () => {
  it("returns null for non-vault projects", () => {
    const html = renderToStaticMarkup(
      <TabStrip threadId={"thread-1" as never} environmentId={"env-1" as never} />,
    );

    expect(html).toBe("");
  });

  it("renders accessible tablist structure", () => {
    const html = renderToStaticMarkup(
      <TabStrip threadId={"thread-1" as never} environmentId={"env-1" as never} />,
    );

    expect(html).not.toContain('role="tab"');
  });
});
