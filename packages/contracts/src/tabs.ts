import * as Rpc from "effect/unstable/rpc/Rpc";
import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";

export const TabId = Schema.String.pipe(Schema.brand("TabId"));
export type TabId = typeof TabId.Type;

export const TABS_WS_METHODS = {
  getThreadState: "tabs.getThreadState",
  setThreadState: "tabs.setThreadState",
  openNoteTab: "tabs.openNoteTab",
  closeTab: "tabs.closeTab",
  activateTab: "tabs.activateTab",
  reorderTabs: "tabs.reorderTabs",
  subscribeThreadState: "tabs.subscribeThreadState",
} as const;

export const ChatTab = Schema.Struct({
  kind: Schema.Literal("chat"),
  id: ThreadId,
  title: Schema.String,
});
export type ChatTab = typeof ChatTab.Type;

export const NoteTab = Schema.Struct({
  kind: Schema.Literal("note"),
  id: TabId,
  vaultId: ProjectId,
  relativePath: Schema.String,
  scrollPos: Schema.Number,
  isDirty: Schema.Boolean,
});
export type NoteTab = typeof NoteTab.Type;

export const Tab = Schema.Union([ChatTab, NoteTab]);
export type Tab = typeof Tab.Type;

export const ThreadTabState = Schema.Struct({
  threadId: ThreadId,
  tabs: Schema.Array(Tab),
  activeTabId: Schema.String,
});
export type ThreadTabState = typeof ThreadTabState.Type;

export const TabStateChange = Schema.Struct({
  threadId: ThreadId,
  state: ThreadTabState,
});
export type TabStateChange = typeof TabStateChange.Type;

export const WsTabsGetThreadStateRpc = Rpc.make(TABS_WS_METHODS.getThreadState, {
  payload: Schema.Struct({ threadId: ThreadId }),
  success: ThreadTabState,
});

export const WsTabsSetThreadStateRpc = Rpc.make(TABS_WS_METHODS.setThreadState, {
  payload: Schema.Struct({ threadId: ThreadId, state: ThreadTabState }),
});

export const WsTabsOpenNoteTabRpc = Rpc.make(TABS_WS_METHODS.openNoteTab, {
  payload: Schema.Struct({
    threadId: ThreadId,
    vaultId: ProjectId,
    relativePath: Schema.String,
  }),
  success: Tab,
});

export const WsTabsCloseTabRpc = Rpc.make(TABS_WS_METHODS.closeTab, {
  payload: Schema.Struct({ threadId: ThreadId, tabId: TabId }),
});

export const WsTabsActivateTabRpc = Rpc.make(TABS_WS_METHODS.activateTab, {
  payload: Schema.Struct({ threadId: ThreadId, tabId: TabId }),
});

export const WsTabsReorderTabsRpc = Rpc.make(TABS_WS_METHODS.reorderTabs, {
  payload: Schema.Struct({ threadId: ThreadId, orderedIds: Schema.Array(Schema.String) }),
});

export const WsTabsSubscribeThreadStateRpc = Rpc.make(TABS_WS_METHODS.subscribeThreadState, {
  payload: Schema.Struct({ threadId: ThreadId }),
  success: TabStateChange,
  stream: true,
});
