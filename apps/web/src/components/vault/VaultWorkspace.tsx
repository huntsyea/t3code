import {
  type EnvironmentId,
  type ProjectId,
  type Tab,
  type TabStateChange,
  type ThreadId,
  type ThreadTabState,
} from "@t3tools/contracts";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentConnection } from "../../environments/runtime";
import { MarkdownEditor } from "../editor/MarkdownEditor";
import { TabStrip } from "../tabs/TabStrip";
import { EmptyWorkspace } from "./EmptyWorkspace";

interface VaultWorkspaceProps {
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly isVaultProject: boolean;
  readonly children: ReactNode;
}

function findActiveTab(state: ThreadTabState | null): Tab | null {
  if (!state) return null;
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
}

function useThreadTabState(
  threadId: ThreadId,
  environmentId: EnvironmentId,
  enabled: boolean,
): ThreadTabState | null {
  const connection = readEnvironmentConnection(environmentId);
  const [state, setState] = useState<ThreadTabState | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  const applyState = useCallback((nextState: ThreadTabState) => {
    setState(nextState);
  }, []);

  useEffect(() => {
    unsubRef.current?.();
    unsubRef.current = null;

    if (!enabled || !connection) {
      setState(null);
      return;
    }

    let cancelled = false;

    const refresh = () => {
      connection.client.tabs
        .getThreadState({ threadId })
        .then((nextState) => {
          if (!cancelled && nextState) {
            applyState(nextState);
          }
        })
        .catch(() => undefined);
    };

    refresh();

    unsubRef.current = connection.client.tabs.subscribeThreadState(
      { threadId },
      (change: TabStateChange) => {
        if (!cancelled && change.threadId === threadId) {
          applyState(change.state);
        }
      },
      {
        onResubscribe: refresh,
      },
    );

    return () => {
      cancelled = true;
      unsubRef.current?.();
      unsubRef.current = null;
    };
  }, [applyState, connection, enabled, threadId]);

  return state;
}

export function VaultWorkspace({
  threadId,
  environmentId,
  projectId,
  isVaultProject,
  children,
}: VaultWorkspaceProps) {
  const tabState = useThreadTabState(threadId, environmentId, isVaultProject);
  const activeTab = useMemo(() => findActiveTab(tabState), [tabState]);

  if (!isVaultProject || !projectId) {
    return <>{children}</>;
  }

  return (
    <>
      <TabStrip threadId={threadId} environmentId={environmentId} />
      {activeTab?.kind === "note" ? (
        <MarkdownEditor
          threadId={threadId}
          environmentId={environmentId}
          projectId={projectId}
          relativePath={activeTab.relativePath}
          className="min-h-0 flex-1"
        />
      ) : tabState?.tabs.length === 0 ? (
        <EmptyWorkspace threadId={threadId} environmentId={environmentId} />
      ) : (
        children
      )}
    </>
  );
}
