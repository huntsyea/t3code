import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  ChatTab,
  NoteTab,
  ProjectId,
  Tab,
  TabId,
  TabStateChange,
  ThreadTabState,
} from "../src/index.ts";

const decode = (schema: Schema.Top, input: unknown): any =>
  (Schema.decodeUnknownSync as any)(schema)(input);

const encode = (schema: Schema.Top, input: unknown): any =>
  (Schema.encodeSync as any)(schema)(input);

describe("tab schemas", () => {
  it("parses ChatTab", () => {
    const parsed = decode(ChatTab, {
      kind: "chat",
      id: "thread-1",
      title: "Chat",
    });

    expect(parsed).toMatchObject({ kind: "chat", id: "thread-1", title: "Chat" });
  });

  it("parses NoteTab", () => {
    const parsed = decode(NoteTab, {
      kind: "note",
      id: "tab-1",
      vaultId: "project-1",
      relativePath: "notes/todo.md",
      scrollPos: 42,
      isDirty: true,
    });

    expect(parsed).toMatchObject({ kind: "note", relativePath: "notes/todo.md" });
  });

  it("parses both Tab union kinds", () => {
    const chat = decode(Tab, {
      kind: "chat",
      id: "thread-1",
      title: "Chat",
    });
    const note = decode(Tab, {
      kind: "note",
      id: "tab-1",
      vaultId: "project-1",
      relativePath: "notes/todo.md",
      scrollPos: 0,
      isDirty: false,
    });

    expect(chat.kind).toBe("chat");
    expect(note.kind).toBe("note");
  });

  it("rejects invalid tab kinds", () => {
    expect(() =>
      decode(Tab, {
        kind: "graph",
      }),
    ).toThrow(/Expected/);
  });

  it("rejects invalid note tab fields", () => {
    expect(() =>
      decode(Tab, {
        kind: "note",
        id: "tab-1",
        vaultId: "project-1",
        relativePath: 42,
        scrollPos: 0,
        isDirty: false,
      }),
    ).toThrow(/Expected/);
  });

  it("round-trips tab values", () => {
    const original: Schema.Schema.Type<typeof Tab> = {
      kind: "note",
      id: "tab-1" as TabId,
      vaultId: "project-1" as Schema.Schema.Type<typeof ProjectId>,
      relativePath: "notes/todo.md",
      scrollPos: 12,
      isDirty: true,
    };

    const encoded = encode(Tab, original);
    const decoded = decode(Tab, encoded);

    expect(decoded).toEqual(original);
  });

  it("exports tab state shapes from index", () => {
    const state = decode(ThreadTabState, {
      threadId: "thread-1",
      tabs: [
        { kind: "chat", id: "thread-1", title: "Chat" },
        {
          kind: "note",
          id: "tab-1",
          vaultId: "project-1",
          relativePath: "notes/todo.md",
          scrollPos: 0,
          isDirty: false,
        },
      ],
      activeTabId: "tab-1",
    });
    const change = decode(TabStateChange, {
      threadId: "thread-1",
      state,
    });

    expect(change.state.tabs).toHaveLength(2);
  });
});
