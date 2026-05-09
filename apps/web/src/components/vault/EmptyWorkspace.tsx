import {
  type EnvironmentId,
  type TabStateChange,
  type ThreadId,
  type ThreadTabState,
} from "@t3tools/contracts";
import { MessageSquarePlusIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { readEnvironmentConnection } from "../../environments/runtime";
import { useStore } from "../../store";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { openOrActivateChatTab } from "./openChatTab";

interface EmptyWorkspaceProps {
  threadId: ThreadId;
  environmentId: EnvironmentId;
}

export function EmptyWorkspace({ threadId, environmentId }: EmptyWorkspaceProps) {
  const projectKind = useStore((store) => {
    const environmentState = store.environmentStateById[environmentId];
    if (!environmentState) return undefined;
    const shell = environmentState.threadShellById[threadId];
    if (!shell) return undefined;
    return environmentState.projectById[shell.projectId]?.kind;
  });

  if (projectKind !== "vault") return null;

  return <EmptyWorkspaceInner threadId={threadId} environmentId={environmentId} />;
}

function EmptyWorkspaceInner({ threadId, environmentId }: EmptyWorkspaceProps) {
  const [tabCount, setTabCount] = useState<number | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  const connection = readEnvironmentConnection(environmentId);

  const applyState = useCallback((state: ThreadTabState) => {
    setTabCount(state.tabs.length);
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

  const handleStartChatting = useCallback(() => {
    openOrActivateChatTab({ environmentId, threadId }).catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open chat tab",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    });
  }, [environmentId, threadId]);

  if (tabCount === null || tabCount > 0) return null;

  return (
    <div
      data-testid="empty-workspace"
      className="flex min-h-0 flex-1 items-center justify-center bg-background px-6 py-12"
    >
      <div className="flex max-w-md flex-col items-center gap-5 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <MessageSquarePlusIcon className="size-6" />
        </div>
        <div className="flex flex-col gap-1.5">
          <h2 className="font-semibold text-foreground text-lg">Your Vault</h2>
          <p className="text-muted-foreground text-sm">
            Open a note from the file tree or start a conversation.
          </p>
        </div>
        <Button onClick={handleStartChatting} size="sm" data-testid="empty-workspace-start-chat">
          <MessageSquarePlusIcon />
          Start chatting
        </Button>
      </div>
    </div>
  );
}
