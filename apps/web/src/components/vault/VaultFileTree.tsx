import {
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type VaultEntry,
} from "@t3tools/contracts";
import { ChevronRightIcon, FileTextIcon, FolderClosedIcon, FolderIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentConnection } from "../../environments/runtime";
import { cn } from "~/lib/utils";

interface VaultFileTreeProps {
  threadId: ThreadId;
  environmentId: EnvironmentId;
  projectId: ProjectId;
}

interface DirectoryState {
  status: "idle" | "loading" | "loaded" | "error";
  entries: ReadonlyArray<VaultEntry>;
  error?: string;
}

const ROOT_DIR_KEY = "";

function sortEntries(entries: ReadonlyArray<VaultEntry>): VaultEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "dir" ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

function noteDisplayName(name: string): string {
  return name.endsWith(".md") ? name.slice(0, -".md".length) : name;
}

export const VaultFileTree = memo(function VaultFileTree({
  threadId,
  environmentId,
  projectId,
}: VaultFileTreeProps) {
  const connection = readEnvironmentConnection(environmentId);
  const [directoriesByPath, setDirectoriesByPath] = useState<Record<string, DirectoryState>>({});
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
  const inFlightRef = useRef<Set<string>>(new Set());

  const loadDirectory = useCallback(
    async (relativeDir: string) => {
      if (!connection) return;
      if (inFlightRef.current.has(relativeDir)) return;
      inFlightRef.current.add(relativeDir);
      setDirectoriesByPath((current) => ({
        ...current,
        [relativeDir]: {
          status: "loading",
          entries: current[relativeDir]?.entries ?? [],
        },
      }));
      try {
        const result = await connection.client.vault.listEntries({
          projectId,
          relativeDir,
        });
        setDirectoriesByPath((current) => ({
          ...current,
          [relativeDir]: {
            status: "loaded",
            entries: sortEntries(result.entries),
          },
        }));
      } catch (error) {
        setDirectoriesByPath((current) => ({
          ...current,
          [relativeDir]: {
            status: "error",
            entries: current[relativeDir]?.entries ?? [],
            error: error instanceof Error ? error.message : "Failed to load entries",
          },
        }));
      } finally {
        inFlightRef.current.delete(relativeDir);
      }
    },
    [connection, projectId],
  );

  useEffect(() => {
    setDirectoriesByPath({});
    setExpandedPaths({});
    inFlightRef.current.clear();
    void loadDirectory(ROOT_DIR_KEY);
  }, [projectId, loadDirectory]);

  const toggleDirectory = useCallback(
    (relativeDir: string) => {
      setExpandedPaths((current) => {
        const wasExpanded = Boolean(current[relativeDir]);
        if (!wasExpanded) {
          const directoryState = directoriesByPath[relativeDir];
          if (!directoryState || directoryState.status === "idle") {
            void loadDirectory(relativeDir);
          }
        }
        return { ...current, [relativeDir]: !wasExpanded };
      });
    },
    [directoriesByPath, loadDirectory],
  );

  const openNote = useCallback(
    (entry: VaultEntry) => {
      if (!connection) return;
      void connection.client.tabs.openNoteTab({
        threadId,
        vaultId: projectId,
        relativePath: entry.relativePath,
      });
    },
    [connection, projectId, threadId],
  );

  const rootState = directoriesByPath[ROOT_DIR_KEY];
  const rootIsLoading = !rootState || rootState.status === "loading";
  const rootHasEntries = rootState?.status === "loaded" && rootState.entries.length > 0;

  return (
    <div
      role="tree"
      aria-label="Vault files"
      className="flex h-full min-h-0 flex-col overflow-y-auto border-l border-border bg-card/30 py-2"
    >
      <div className="flex items-center gap-1.5 px-3 pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Files
      </div>
      {rootIsLoading && !rootState?.entries.length ? (
        <div className="px-3 py-1.5 text-xs text-muted-foreground">Loading…</div>
      ) : rootState?.status === "error" ? (
        <div className="px-3 py-1.5 text-xs text-destructive">
          {rootState.error ?? "Failed to load vault."}
        </div>
      ) : rootHasEntries ? (
        <div className="flex flex-col">
          {rootState.entries.map((entry) => (
            <VaultEntryNode
              key={entry.relativePath}
              entry={entry}
              depth={0}
              expandedPaths={expandedPaths}
              directoriesByPath={directoriesByPath}
              onToggle={toggleDirectory}
              onOpenNote={openNote}
            />
          ))}
        </div>
      ) : (
        <div className="px-3 py-1.5 text-xs text-muted-foreground">No notes yet</div>
      )}
    </div>
  );
});

interface VaultEntryNodeProps {
  entry: VaultEntry;
  depth: number;
  expandedPaths: Record<string, boolean>;
  directoriesByPath: Record<string, DirectoryState>;
  onToggle: (relativeDir: string) => void;
  onOpenNote: (entry: VaultEntry) => void;
}

const VaultEntryNode = memo(function VaultEntryNode({
  entry,
  depth,
  expandedPaths,
  directoriesByPath,
  onToggle,
  onOpenNote,
}: VaultEntryNodeProps) {
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const target = event.currentTarget;
      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault();
          focusSibling(target, 1);
          return;
        }
        case "ArrowUp": {
          event.preventDefault();
          focusSibling(target, -1);
          return;
        }
        case "ArrowRight": {
          if (entry.kind === "dir") {
            event.preventDefault();
            const isExpanded = Boolean(expandedPaths[entry.relativePath]);
            if (!isExpanded) {
              onToggle(entry.relativePath);
            } else {
              focusSibling(target, 1);
            }
          }
          return;
        }
        case "ArrowLeft": {
          if (entry.kind === "dir" && expandedPaths[entry.relativePath]) {
            event.preventDefault();
            onToggle(entry.relativePath);
          }
          return;
        }
        case "Enter":
        case " ": {
          event.preventDefault();
          if (entry.kind === "dir") {
            onToggle(entry.relativePath);
          } else if (entry.name.endsWith(".md")) {
            onOpenNote(entry);
          }
          return;
        }
        default:
          return;
      }
    },
    [entry, expandedPaths, onOpenNote, onToggle],
  );

  const leftPadding = 8 + depth * 14;
  const childState = entry.kind === "dir" ? directoriesByPath[entry.relativePath] : undefined;
  const childEntries = useMemoizedEntries(childState);

  if (entry.kind === "dir") {
    const isExpanded = Boolean(expandedPaths[entry.relativePath]);
    return (
      <div role="treeitem" aria-expanded={isExpanded} aria-level={depth + 1}>
        <button
          type="button"
          onClick={() => onToggle(entry.relativePath)}
          onKeyDown={handleKeyDown}
          tabIndex={0}
          className="group flex w-full items-center gap-1.5 py-1 pr-2 text-left text-sm hover:bg-accent/50"
          style={{ paddingLeft: `${leftPadding}px` }}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
              isExpanded && "rotate-90",
            )}
          />
          {isExpanded ? (
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
          ) : (
            <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
          )}
          <span className="truncate text-foreground/90">{entry.name}</span>
        </button>
        {isExpanded && (
          <div role="group">
            {childState?.status === "loading" && childEntries.length === 0 ? (
              <div
                className="py-1 pr-2 text-xs text-muted-foreground"
                style={{ paddingLeft: `${leftPadding + 22}px` }}
              >
                Loading…
              </div>
            ) : childState?.status === "error" ? (
              <div
                className="py-1 pr-2 text-xs text-destructive"
                style={{ paddingLeft: `${leftPadding + 22}px` }}
              >
                {childState.error ?? "Failed to load entries"}
              </div>
            ) : childEntries.length === 0 ? (
              <div
                className="py-1 pr-2 text-xs text-muted-foreground"
                style={{ paddingLeft: `${leftPadding + 22}px` }}
              >
                Empty
              </div>
            ) : (
              childEntries.map((childEntry) => (
                <VaultEntryNode
                  key={childEntry.relativePath}
                  entry={childEntry}
                  depth={depth + 1}
                  expandedPaths={expandedPaths}
                  directoriesByPath={directoriesByPath}
                  onToggle={onToggle}
                  onOpenNote={onOpenNote}
                />
              ))
            )}
          </div>
        )}
      </div>
    );
  }

  const isMarkdown = entry.name.endsWith(".md");
  return (
    <div role="treeitem" aria-level={depth + 1}>
      <button
        type="button"
        onClick={() => isMarkdown && onOpenNote(entry)}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        disabled={!isMarkdown}
        className={cn(
          "group flex w-full items-center gap-1.5 py-1 pr-2 text-left text-sm hover:bg-accent/50",
          !isMarkdown && "cursor-default opacity-60",
        )}
        style={{ paddingLeft: `${leftPadding + 14}px` }}
      >
        <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
        <span className="truncate text-foreground/90">{noteDisplayName(entry.name)}</span>
      </button>
    </div>
  );
});

function useMemoizedEntries(state: DirectoryState | undefined): ReadonlyArray<VaultEntry> {
  return useMemo(() => state?.entries ?? [], [state?.entries]);
}

function focusSibling(target: HTMLElement, direction: 1 | -1): void {
  const root = target.closest('[role="tree"]');
  if (!root) return;
  const focusable = Array.from(root.querySelectorAll<HTMLElement>('button[tabindex="0"]'));
  if (focusable.length === 0) return;
  const currentIndex = focusable.indexOf(target);
  if (currentIndex === -1) return;
  const nextIndex = (currentIndex + direction + focusable.length) % focusable.length;
  focusable[nextIndex]?.focus();
}
