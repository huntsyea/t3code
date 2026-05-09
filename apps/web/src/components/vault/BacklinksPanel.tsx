import {
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type VaultBacklink,
} from "@t3tools/contracts";
import { ChevronRightIcon, FileTextIcon, LinkIcon } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { readEnvironmentConnection } from "../../environments/runtime";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import * as Schema from "effect/Schema";
import { cn } from "~/lib/utils";

interface BacklinksPanelProps {
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly relativePath: string;
}

interface BacklinksState {
  readonly status: "idle" | "loading" | "loaded" | "error";
  readonly backlinks: ReadonlyArray<VaultBacklink>;
  readonly error?: string;
}

const COLLAPSE_KEY = "atlas.backlinksOpen";

function basenameForRelativePath(relativePath: string): string {
  const last = relativePath.split("/").pop() ?? relativePath;
  return last.endsWith(".md") ? last.slice(0, -".md".length) : last;
}

function backlinkDisplayName(sourcePath: string): string {
  const base = sourcePath.split("/").pop() ?? sourcePath;
  return base.endsWith(".md") ? base.slice(0, -".md".length) : base;
}

export const BacklinksPanel = memo(function BacklinksPanel({
  threadId,
  environmentId,
  projectId,
  relativePath,
}: BacklinksPanelProps) {
  const connection = readEnvironmentConnection(environmentId);
  const [state, setState] = useState<BacklinksState>({ status: "idle", backlinks: [] });
  const [isOpen, setIsOpen] = useLocalStorage(COLLAPSE_KEY, true, Schema.Boolean);
  const inFlightRef = useRef(false);
  const targetBasename = basenameForRelativePath(relativePath);

  const loadBacklinks = useCallback(async () => {
    if (!connection) return;
    if (inFlightRef.current) return;
    if (targetBasename.length === 0) return;
    inFlightRef.current = true;
    setState((current) => ({ ...current, status: "loading" }));
    try {
      const result = await connection.client.vault.getBacklinks({
        projectId,
        targetBasename,
      });
      setState({ status: "loaded", backlinks: result.backlinks });
    } catch (error) {
      setState((current) => ({
        ...current,
        status: "error",
        error: error instanceof Error ? error.message : "Failed to load backlinks",
      }));
    } finally {
      inFlightRef.current = false;
    }
  }, [connection, projectId, targetBasename]);

  useEffect(() => {
    setState({ status: "idle", backlinks: [] });
    void loadBacklinks();
  }, [loadBacklinks]);

  useEffect(() => {
    if (!connection) return;
    return connection.client.vault.subscribeIndexUpdates({ projectId }, (update) => {
      if (update.projectId !== projectId) return;
      void loadBacklinks();
    });
  }, [connection, projectId, loadBacklinks]);

  const openSource = useCallback(
    (sourcePath: string) => {
      if (!connection) return;
      void connection.client.tabs.openNoteTab({
        threadId,
        vaultId: projectId,
        relativePath: sourcePath,
      });
    },
    [connection, projectId, threadId],
  );

  const count = state.backlinks.length;

  return (
    <div className="border-t border-border" data-testid="backlinks-panel">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-accent/40"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 text-muted-foreground/70 transition-transform",
            isOpen && "rotate-90",
          )}
        />
        <LinkIcon aria-hidden="true" className="size-3" />
        <span>Backlinks</span>
        <span className="ml-auto font-normal normal-case text-muted-foreground/70">
          {state.status === "loading" && count === 0 ? "…" : count}
        </span>
      </button>
      {isOpen ? (
        <div className="pb-2">
          {state.status === "error" ? (
            <div className="px-3 py-1 text-xs text-destructive">
              {state.error ?? "Failed to load backlinks"}
            </div>
          ) : state.status === "loading" && count === 0 ? (
            <div className="px-3 py-1 text-xs text-muted-foreground">Loading…</div>
          ) : count === 0 ? (
            <div className="px-3 py-1 text-xs text-muted-foreground">
              No notes link to this one yet.
            </div>
          ) : (
            <ul role="list" className="flex flex-col">
              {state.backlinks.map((backlink) => (
                <li key={backlink.sourcePath}>
                  <button
                    type="button"
                    onClick={() => openSource(backlink.sourcePath)}
                    className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-sm hover:bg-accent/50"
                  >
                    <FileTextIcon
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-muted-foreground/80"
                    />
                    <span className="truncate text-foreground/90">
                      {backlinkDisplayName(backlink.sourcePath)}
                    </span>
                    <span className="ml-auto truncate text-xs text-muted-foreground/60">
                      {backlink.sourcePath}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
});
