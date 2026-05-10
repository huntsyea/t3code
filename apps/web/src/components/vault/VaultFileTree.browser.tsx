import "../../index.css";

import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const {
  getThreadStateMock,
  listEntriesMock,
  listTagsMock,
  openNoteTabMock,
  readEnvironmentConnectionMock,
  resetTabState,
  subscribeThreadStateMock,
} = vi.hoisted(() => {
  type TestThreadState = {
    threadId: string;
    tabs: Array<Record<string, unknown>>;
    activeTabId: string;
  };

  let threadState: TestThreadState = {
    threadId: "thread-1",
    tabs: [{ kind: "chat", id: "thread-1", title: "Chat" }],
    activeTabId: "thread-1",
  };
  const listeners = new Set<(change: { threadId: string; state: typeof threadState }) => void>();

  const resetTabState = () => {
    threadState = {
      threadId: "thread-1",
      tabs: [{ kind: "chat", id: "thread-1", title: "Chat" }],
      activeTabId: "thread-1",
    };
    listeners.clear();
  };

  const getThreadStateMock = vi.fn(async () => threadState);
  const listEntriesMock = vi.fn(async () => ({
    entries: [
      {
        kind: "file",
        name: "Daily Note.md",
        relativePath: "Daily Note.md",
      },
    ],
  }));
  const listTagsMock = vi.fn(async () => ({ tags: [] }));
  const openNoteTabMock = vi.fn(async ({ threadId, vaultId, relativePath }) => {
    const tab = {
      kind: "note",
      id: "tab-note-1",
      vaultId,
      relativePath,
      scrollPos: 0,
      isDirty: false,
    };
    threadState = {
      threadId,
      tabs: [{ kind: "chat", id: threadId, title: "Chat" }, tab],
      activeTabId: tab.id,
    };
    for (const listener of listeners) {
      listener({ threadId, state: threadState });
    }
    return tab;
  });
  const subscribeThreadStateMock = vi.fn((input, listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const readEnvironmentConnectionMock = vi.fn(() => ({
    client: {
      tabs: {
        getThreadState: getThreadStateMock,
        openNoteTab: openNoteTabMock,
        subscribeThreadState: subscribeThreadStateMock,
      },
      vault: {
        listEntries: listEntriesMock,
        listTags: listTagsMock,
      },
    },
  }));

  return {
    getThreadStateMock,
    listEntriesMock,
    listTagsMock,
    openNoteTabMock,
    readEnvironmentConnectionMock,
    resetTabState,
    subscribeThreadStateMock,
  };
});

vi.mock("../../environments/runtime", () => ({
  readEnvironmentConnection: readEnvironmentConnectionMock,
}));

vi.mock("../editor/MarkdownEditor", () => ({
  MarkdownEditor: ({ relativePath }: { readonly relativePath: string }) => (
    <div data-testid="markdown-editor">{relativePath}</div>
  ),
}));

import { VaultFileTree } from "./VaultFileTree";
import { VaultWorkspace } from "./VaultWorkspace";

describe("VaultFileTree", () => {
  beforeEach(() => {
    resetTabState();
    getThreadStateMock.mockClear();
    listEntriesMock.mockClear();
    listTagsMock.mockClear();
    openNoteTabMock.mockClear();
    readEnvironmentConnectionMock.mockClear();
    subscribeThreadStateMock.mockClear();
    document.body.innerHTML = "";
  });

  it("opens a markdown file in the workspace editor when clicked", async () => {
    const screen = await render(
      <div>
        <VaultWorkspace
          threadId={"thread-1" as never}
          environmentId={"environment-1" as never}
          projectId={"project-1" as never}
          isVaultProject
        >
          <div>Chat content</div>
        </VaultWorkspace>
        <VaultFileTree
          threadId={"thread-1" as never}
          environmentId={"environment-1" as never}
          projectId={"project-1" as never}
        />
      </div>,
    );

    try {
      const noteButton = page.getByRole("button", { name: "Daily Note" });
      await expect.element(noteButton).toBeInTheDocument();

      await noteButton.click();

      await vi.waitFor(() => {
        expect(openNoteTabMock).toHaveBeenCalledWith({
          threadId: "thread-1",
          vaultId: "project-1",
          relativePath: "Daily Note.md",
        });
      });
      await expect.element(page.getByTestId("markdown-editor")).toHaveTextContent("Daily Note.md");
    } finally {
      await screen.unmount();
    }
  });
});
