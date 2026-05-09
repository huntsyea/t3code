import {
  type EnvironmentId,
  type Tab,
  type TabId,
  type TabStateChange,
  type ThreadId,
  type ThreadTabState,
} from "@t3tools/contracts";
import { FileTextIcon, MessageSquareIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { readEnvironmentConnection } from "../../environments/runtime";
import { useStore } from "../../store";

function basename(filePath: string, ext: string): string {
  const lastSep = filePath.lastIndexOf("/");
  const name = lastSep >= 0 ? filePath.slice(lastSep + 1) : filePath;
  if (ext.length > 0 && name.endsWith(ext)) {
    return name.slice(0, name.length - ext.length);
  }
  return name;
}

function tabId(tab: Tab): string {
  return tab.kind === "chat" ? tab.id : tab.id;
}

interface TabStripProps {
  threadId: ThreadId;
  environmentId: EnvironmentId;
}

export function TabStrip({ threadId, environmentId }: TabStripProps) {
  const projectKind = useStore((store) => {
    const environmentState = store.environmentStateById[environmentId];
    if (!environmentState) return undefined;
    const shell = environmentState.threadShellById[threadId];
    if (!shell) return undefined;
    return environmentState.projectById[shell.projectId]?.kind;
  });

  if (projectKind !== "vault") return null;

  return <TabStripInner threadId={threadId} environmentId={environmentId} />;
}

function TabStripInner({ threadId, environmentId }: TabStripProps) {
  const [tabs, setTabs] = useState<readonly Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const tablistRef = useRef<HTMLDivElement>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const dragIndexRef = useRef<number | null>(null);

  const connection = readEnvironmentConnection(environmentId);

  const applyState = useCallback((state: ThreadTabState) => {
    setTabs(state.tabs);
    setActiveTabId(state.activeTabId);
  }, []);

  useEffect(() => {
    if (!connection) return;

    let cancelled = false;

    connection.client.tabs
      .getThreadState({ threadId })
      .then((state) => {
        if (!cancelled && state) {
          applyState(state);
        }
      })
      .catch(() => undefined);

    unsubRef.current = connection.client.tabs.subscribeThreadState(
      { threadId },
      (change: TabStateChange) => {
        if (!cancelled && change.threadId === threadId) {
          applyState(change.state);
        }
      },
      {
        onResubscribe: () => {
          connection.client.tabs
            .getThreadState({ threadId })
            .then((state) => {
              if (!cancelled && state) {
                applyState(state);
              }
            })
            .catch(() => undefined);
        },
      },
    );

    return () => {
      cancelled = true;
      unsubRef.current?.();
      unsubRef.current = null;
    };
  }, [threadId, connection, applyState]);

  const activateTab = useCallback(
    (id: string) => {
      if (!connection) return;
      void connection.client.tabs.activateTab({
        threadId,
        tabId: id as TabId,
      });
    },
    [connection, threadId],
  );

  const closeTab = useCallback(
    (id: string) => {
      if (!connection) return;
      void connection.client.tabs.closeTab({
        threadId,
        tabId: id as TabId,
      });
    },
    [connection, threadId],
  );

  const closeActiveTab = useCallback(() => {
    if (!activeTabId) return;
    closeTab(activeTabId);
  }, [activeTabId, closeTab]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const isMeta = event.metaKey || event.ctrlKey;

      if (isMeta && event.key === "w") {
        event.preventDefault();
        closeActiveTab();
        return;
      }

      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        const tabElements = Array.from(
          tablistRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
        );
        if (tabElements.length === 0) return;

        const currentIndex = tabElements.indexOf(document.activeElement as HTMLElement);
        const nextIndex =
          event.key === "ArrowRight"
            ? (currentIndex + 1) % tabElements.length
            : (currentIndex - 1 + tabElements.length) % tabElements.length;

        tabElements[nextIndex]?.focus();
        return;
      }

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const focused = document.activeElement as HTMLElement | null;
        const tabId = focused?.getAttribute("data-tab-id");
        if (tabId) {
          activateTab(tabId);
        }
      }
    },
    [activateTab, closeActiveTab],
  );

  const handleDragStart = useCallback((event: React.DragEvent, index: number) => {
    dragIndexRef.current = index;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(index));
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent, dropIndex: number) => {
      event.preventDefault();
      const sourceIndex = dragIndexRef.current;
      dragIndexRef.current = null;

      if (sourceIndex === null || sourceIndex === dropIndex) return;
      if (!connection || tabs.length < 2) return;

      const nextTabs = [...tabs];
      const [moved] = nextTabs.splice(sourceIndex, 1);
      if (!moved) return;
      nextTabs.splice(dropIndex, 0, moved);

      const orderedIds = nextTabs.map(tabId);
      void connection.client.tabs.reorderTabs({
        threadId,
        orderedIds,
      });
    },
    [connection, tabs, threadId],
  );

  const handleDragEnd = useCallback(() => {
    dragIndexRef.current = null;
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "w") {
        const tablist = tablistRef.current;
        if (!tablist) return;
        const active = document.activeElement;
        if (!active) return;
        if (!tablist.contains(active)) return;
        event.preventDefault();
        closeActiveTab();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeActiveTab]);

  if (tabs.length === 0) return null;

  return (
    <div
      ref={tablistRef}
      role="tablist"
      aria-label="Workspace tabs"
      className="flex shrink-0 items-start gap-0 overflow-x-auto border-b border-border bg-card/50"
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab, index) => (
        <TabItem
          key={tabId(tab)}
          tab={tab}
          index={index}
          isActive={tabId(tab) === activeTabId}
          onActivate={activateTab}
          onClose={closeTab}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onDragEnd={handleDragEnd}
        />
      ))}
    </div>
  );
}

interface TabItemProps {
  tab: Tab;
  index: number;
  isActive: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onDragStart: (event: React.DragEvent, index: number) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent, index: number) => void;
  onDragEnd: () => void;
}

function TabItem({
  tab,
  index,
  isActive,
  onActivate,
  onClose,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: TabItemProps) {
  const id = tabId(tab);
  const isChat = tab.kind === "chat";

  const icon = isChat ? (
    <MessageSquareIcon className="size-3.5 shrink-0" />
  ) : (
    <FileTextIcon className="size-3.5 shrink-0" />
  );

  const title = isChat ? tab.title : basename(tab.relativePath, ".md");

  const isDirty = !isChat && tab.isDirty;

  const handleClick = useCallback(() => {
    onActivate(id);
  }, [id, onActivate]);

  const handleClose = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onClose(id);
    },
    [id, onClose],
  );

  const handleMiddleClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.button === 1) {
        event.preventDefault();
        onClose(id);
      }
    },
    [id, onClose],
  );

  return (
    <div
      role="tab"
      data-tab-id={id}
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      draggable
      onClick={handleClick}
      onMouseDown={handleMiddleClick}
      onDragStart={(event) => onDragStart(event, index)}
      onDragOver={onDragOver}
      onDrop={(event) => onDrop(event, index)}
      onDragEnd={onDragEnd}
      className={[
        "group/tab relative flex shrink-0 cursor-pointer select-none items-center gap-1.5",
        "border-r border-border px-3 py-2 text-sm font-medium leading-none",
        "transition-colors",
        isActive
          ? "bg-background text-foreground"
          : "bg-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      ].join(" ")}
    >
      {icon}
      <span className="max-w-[160px] truncate">{title}</span>
      {isDirty && (
        <span
          className="ml-0.5 size-1.5 shrink-0 rounded-full bg-amber-500"
          aria-label="Unsaved changes"
        />
      )}
      <button
        type="button"
        onClick={handleClose}
        className={[
          "ml-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm",
          "text-muted-foreground/70 hover:bg-muted hover:text-foreground",
          "transition-opacity",
          isActive
            ? "opacity-100"
            : "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100",
        ].join(" ")}
        aria-label={`Close ${title}`}
        tabIndex={-1}
      >
        <XIcon className="size-3" />
      </button>
      {isActive && <div className="absolute inset-x-0 bottom-0 h-0.5 bg-foreground" />}
    </div>
  );
}
