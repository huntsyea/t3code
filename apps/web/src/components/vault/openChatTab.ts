import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { readEnvironmentConnection } from "../../environments/runtime";

// Chat tab invariant: ChatTab.id === ThreadId (see packages/contracts/src/tabs.ts).
export async function openOrActivateChatTab(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title?: string;
}): Promise<void> {
  const connection = readEnvironmentConnection(input.environmentId);
  if (!connection) return;

  const state = await connection.client.tabs.getThreadState({ threadId: input.threadId });
  const chatTabId: string = input.threadId;
  const existing = state.tabs.find((tab) => tab.kind === "chat" && tab.id === chatTabId);

  if (existing) {
    if (state.activeTabId !== chatTabId) {
      await connection.client.tabs.activateTab({
        threadId: input.threadId,
        tabId: chatTabId as never,
      });
    }
    return;
  }

  await connection.client.tabs.setThreadState({
    threadId: input.threadId,
    state: {
      threadId: input.threadId,
      tabs: [
        {
          kind: "chat",
          id: input.threadId,
          title: input.title ?? "Chat",
        },
        ...state.tabs,
      ],
      activeTabId: chatTabId,
    },
  });
}
