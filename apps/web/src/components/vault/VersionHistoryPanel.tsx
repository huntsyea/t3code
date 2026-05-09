import {
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type VaultGetVersionHistoryResult,
  type VaultVersionHistoryEntry,
} from "@t3tools/contracts";
import { ClockIcon, GitCommitIcon, HistoryIcon, RotateCcwIcon } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { readEnvironmentConnection } from "../../environments/runtime";
import { Kbd } from "../ui/kbd";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { cn } from "~/lib/utils";

interface VersionHistoryPanelProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly relativePath: string | null;
}

interface HistoryState {
  readonly status: "idle" | "loading" | "loaded" | "error";
  readonly result: VaultGetVersionHistoryResult | null;
  readonly error?: string;
}

function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

function formatTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp.replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) return timestamp;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function noteDisplayName(relativePath: string): string {
  const last = relativePath.split("/").pop() ?? relativePath;
  return last.endsWith(".md") ? last.slice(0, -".md".length) : last;
}

export const VersionHistoryPanel = memo(function VersionHistoryPanel({
  open,
  onOpenChange,
  threadId,
  environmentId,
  projectId,
  relativePath,
}: VersionHistoryPanelProps) {
  if (!open) return null;
  return (
    <VersionHistoryDialog
      threadId={threadId}
      environmentId={environmentId}
      projectId={projectId}
      relativePath={relativePath}
      onClose={() => onOpenChange(false)}
    />
  );
});

interface VersionHistoryDialogProps {
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly relativePath: string | null;
  readonly onClose: () => void;
}

function useActiveNoteRelativePath(
  threadId: ThreadId,
  environmentId: EnvironmentId,
  override: string | null,
): string | null {
  const connection = readEnvironmentConnection(environmentId);
  const [resolved, setResolved] = useState<string | null>(override);

  useEffect(() => {
    if (override) {
      setResolved(override);
      return;
    }
    if (!connection) {
      setResolved(null);
      return;
    }

    let cancelled = false;
    const apply = (state: { tabs: ReadonlyArray<unknown>; activeTabId: string | null }) => {
      if (cancelled) return;
      const activeId = state.activeTabId;
      if (!activeId) {
        setResolved(null);
        return;
      }
      const active = (
        state.tabs as ReadonlyArray<{ id: string; kind: string; relativePath?: string }>
      ).find((tab) => tab.id === activeId);
      if (active && active.kind === "note" && active.relativePath) {
        setResolved(active.relativePath);
      } else {
        setResolved(null);
      }
    };

    void connection.client.tabs
      .getThreadState({ threadId })
      .then((state) => {
        if (state) apply(state as never);
      })
      .catch(() => undefined);

    const unsubscribe = connection.client.tabs.subscribeThreadState(
      { threadId },
      (change) => {
        if (change.threadId !== threadId) return;
        apply(change.state as never);
      },
      {
        onResubscribe: () => {
          void connection.client.tabs
            .getThreadState({ threadId })
            .then((state) => {
              if (state) apply(state as never);
            })
            .catch(() => undefined);
        },
      },
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [connection, threadId, override]);

  return resolved;
}

function VersionHistoryDialog({
  threadId,
  environmentId,
  projectId,
  relativePath,
  onClose,
}: VersionHistoryDialogProps) {
  const activeRelativePath = useActiveNoteRelativePath(threadId, environmentId, relativePath);
  const connection = readEnvironmentConnection(environmentId);
  const [state, setState] = useState<HistoryState>({ status: "idle", result: null });
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [reverting, setReverting] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  const loadHistory = useCallback(async () => {
    if (!connection || !activeRelativePath) {
      setState({ status: "idle", result: null });
      return;
    }
    const requestId = ++requestIdRef.current;
    setState({ status: "loading", result: null });
    try {
      const result = await connection.client.vault.getVersionHistory({
        projectId,
        relativePath: activeRelativePath,
      });
      if (requestId !== requestIdRef.current) return;
      setState({ status: "loaded", result });
      if (result.available && result.revisions.length > 0) {
        setSelectedHash(result.revisions[0]?.hash ?? null);
      } else {
        setSelectedHash(null);
      }
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setState({
        status: "error",
        result: null,
        error: error instanceof Error ? error.message : "Failed to load version history",
      });
    }
  }, [connection, projectId, activeRelativePath]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const revert = useCallback(
    async (hash: string) => {
      if (!connection || !activeRelativePath || reverting) return;
      const confirmed = window.confirm(
        `Revert "${noteDisplayName(activeRelativePath)}" to ${shortHash(hash)}? This creates a new commit.`,
      );
      if (!confirmed) return;
      setReverting(true);
      try {
        await connection.client.vault.revertToVersion({
          projectId,
          relativePath: activeRelativePath,
          hash,
        });
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Reverted note",
            description: `Restored ${noteDisplayName(activeRelativePath)} to ${shortHash(hash)}.`,
          }),
        );
        await loadHistory();
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Revert failed",
            description: error instanceof Error ? error.message : "Failed to revert note.",
          }),
        );
      } finally {
        setReverting(false);
      }
    },
    [connection, projectId, activeRelativePath, reverting, loadHistory],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Version history"
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[10vh]"
    >
      <button
        type="button"
        aria-label="Close version history"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/30 backdrop-blur-[1px]"
      />
      <div className="relative flex w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl shadow-black/30">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <HistoryIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">Version history</div>
            {activeRelativePath ? (
              <div className="truncate text-xs text-muted-foreground">{activeRelativePath}</div>
            ) : (
              <div className="text-xs text-muted-foreground">No active note</div>
            )}
          </div>
          <Kbd className="text-[10px]">Esc</Kbd>
        </div>
        <div className="max-h-[65vh] overflow-y-auto">
          <VersionHistoryBody
            state={state}
            relativePath={activeRelativePath}
            selectedHash={selectedHash}
            onSelect={setSelectedHash}
            onRevert={revert}
            reverting={reverting}
          />
        </div>
      </div>
    </div>
  );
}

interface VersionHistoryBodyProps {
  readonly state: HistoryState;
  readonly relativePath: string | null;
  readonly selectedHash: string | null;
  readonly onSelect: (hash: string) => void;
  readonly onRevert: (hash: string) => void;
  readonly reverting: boolean;
}

function VersionHistoryBody({
  state,
  relativePath,
  selectedHash,
  onSelect,
  onRevert,
  reverting,
}: VersionHistoryBodyProps) {
  if (!relativePath) {
    return (
      <div className="px-4 py-10 text-center text-sm text-muted-foreground">
        Open a note to view its version history.
      </div>
    );
  }
  if (state.status === "loading") {
    return <div className="px-4 py-10 text-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (state.status === "error") {
    return (
      <div className="px-4 py-10 text-center text-sm text-destructive">
        {state.error ?? "Failed to load version history."}
      </div>
    );
  }
  if (!state.result) {
    return null;
  }
  if (!state.result.available) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <div className="text-sm font-medium text-foreground">Version history unavailable</div>
        <div className="max-w-md text-sm text-muted-foreground">
          {state.result.reason === "no-git" ? (
            <>
              Version history requires git. Run{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">git init</code> in your vault
              and commit your notes to enable this feature.
            </>
          ) : (
            <>This note has not been committed to git yet. Save and commit it to track revisions.</>
          )}
        </div>
      </div>
    );
  }
  const revisions = state.result.revisions;
  if (revisions.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-sm text-muted-foreground">
        No revisions found for this note.
      </div>
    );
  }
  return (
    <ul role="list" className="flex flex-col">
      {revisions.map((revision, index) => (
        <RevisionRow
          key={revision.hash}
          revision={revision}
          isSelected={revision.hash === selectedHash}
          isLatest={index === 0}
          onSelect={() => onSelect(revision.hash)}
          onRevert={() => onRevert(revision.hash)}
          disabled={reverting}
        />
      ))}
    </ul>
  );
}

interface RevisionRowProps {
  readonly revision: VaultVersionHistoryEntry;
  readonly isSelected: boolean;
  readonly isLatest: boolean;
  readonly onSelect: () => void;
  readonly onRevert: () => void;
  readonly disabled: boolean;
}

function RevisionRow({
  revision,
  isSelected,
  isLatest,
  onSelect,
  onRevert,
  disabled,
}: RevisionRowProps) {
  return (
    <li
      className={cn(
        "flex items-center gap-3 border-b border-border/40 px-4 py-3 last:border-b-0",
        isSelected ? "bg-accent/40" : "hover:bg-accent/20",
      )}
    >
      <button type="button" onClick={onSelect} className="flex flex-1 items-center gap-3 text-left">
        <GitCommitIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground/80" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">
              {shortHash(revision.hash)}
            </span>
            {isLatest ? (
              <span className="rounded-sm bg-accent px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-foreground">
                Latest
              </span>
            ) : null}
            <span className="flex items-center gap-1 text-xs text-muted-foreground/80">
              <ClockIcon aria-hidden="true" className="size-3" />
              {formatTimestamp(revision.timestamp)}
            </span>
          </div>
          <div className="truncate text-sm text-foreground/90">{revision.message}</div>
        </div>
      </button>
      <button
        type="button"
        onClick={onRevert}
        disabled={disabled || isLatest}
        title={isLatest ? "Already at latest revision" : "Restore this revision"}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs",
          disabled || isLatest
            ? "cursor-not-allowed opacity-50"
            : "hover:border-foreground hover:bg-accent",
        )}
      >
        <RotateCcwIcon aria-hidden="true" className="size-3" />
        Restore
      </button>
    </li>
  );
}
