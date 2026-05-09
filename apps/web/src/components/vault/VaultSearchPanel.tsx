"use client";

import {
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type VaultSearchHit,
} from "@t3tools/contracts";
import { ClockIcon, FileTextIcon, SearchIcon } from "lucide-react";
import { memo, useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import * as Schema from "effect/Schema";

import { readEnvironmentConnection } from "../../environments/runtime";
import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { Kbd } from "../ui/kbd";
import { cn } from "~/lib/utils";

const SEARCH_DEBOUNCE_MS = 200;
const RECENT_SEARCH_KEY = "atlas.vaultSearchRecent";
const RECENT_SEARCH_LIMIT = 8;
const SEARCH_RESULT_LIMIT = 50;
const VAULT_SEARCH_SHORTCUT_KEY = "f";

const RecentSearchesSchema = Schema.Array(Schema.String);

interface VaultSearchPanelProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

function readRecentSearches(): ReadonlyArray<string> {
  try {
    return getLocalStorageItem(RECENT_SEARCH_KEY, RecentSearchesSchema) ?? [];
  } catch {
    return [];
  }
}

function writeRecentSearches(values: ReadonlyArray<string>): void {
  try {
    setLocalStorageItem(RECENT_SEARCH_KEY, values, RecentSearchesSchema);
  } catch {
    return;
  }
}

function noteHitTitle(hit: VaultSearchHit): string {
  if (hit.title && hit.title.trim().length > 0) return hit.title;
  const last = hit.relativePath.split("/").pop() ?? hit.relativePath;
  return last.endsWith(".md") ? last.slice(0, -".md".length) : last;
}

interface SearchState {
  readonly status: "idle" | "loading" | "loaded" | "error";
  readonly hits: ReadonlyArray<VaultSearchHit>;
  readonly error?: string;
}

export const VaultSearchPanel = memo(function VaultSearchPanel({
  open,
  onOpenChange,
  threadId,
  environmentId,
  projectId,
}: VaultSearchPanelProps) {
  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const isShortcut =
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === VAULT_SEARCH_SHORTCUT_KEY;
      if (!isShortcut) return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(!open);
    }
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <VaultSearchPanelDialog
      threadId={threadId}
      environmentId={environmentId}
      projectId={projectId}
      onClose={() => onOpenChange(false)}
    />
  );
});

interface VaultSearchPanelDialogProps {
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly onClose: () => void;
}

function VaultSearchPanelDialog({
  threadId,
  environmentId,
  projectId,
  onClose,
}: VaultSearchPanelDialogProps) {
  const connection = readEnvironmentConnection(environmentId);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [state, setState] = useState<SearchState>({ status: "idle", hits: [] });
  const [recents, setRecents] = useState<ReadonlyArray<string>>(() => readRecentSearches());
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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

  const performSearch = useCallback(
    async (raw: string) => {
      if (!connection) {
        setState({ status: "idle", hits: [] });
        return;
      }
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        setState({ status: "idle", hits: [] });
        return;
      }
      const requestId = ++requestIdRef.current;
      setState((current) => ({ ...current, status: "loading" }));
      try {
        const result = await connection.client.vault.search({
          projectId,
          query: trimmed,
          limit: SEARCH_RESULT_LIMIT,
        });
        if (requestId !== requestIdRef.current) return;
        setState({ status: "loaded", hits: result.hits });
        setHighlightedIndex(0);
      } catch (error) {
        if (requestId !== requestIdRef.current) return;
        setState({
          status: "error",
          hits: [],
          error: error instanceof Error ? error.message : "Search failed",
        });
      }
    },
    [connection, projectId],
  );

  useEffect(() => {
    if (deferredQuery.trim().length === 0) {
      setState({ status: "idle", hits: [] });
      return;
    }
    const timer = window.setTimeout(() => {
      void performSearch(deferredQuery);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [deferredQuery, performSearch]);

  const recordRecent = useCallback((raw: string) => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    setRecents((current) => {
      const next = [trimmed, ...current.filter((entry) => entry !== trimmed)].slice(
        0,
        RECENT_SEARCH_LIMIT,
      );
      writeRecentSearches(next);
      return next;
    });
  }, []);

  const openHit = useCallback(
    (hit: VaultSearchHit) => {
      if (!connection) return;
      void connection.client.tabs.openNoteTab({
        threadId,
        vaultId: projectId,
        relativePath: hit.relativePath,
      });
      recordRecent(query);
      onClose();
    },
    [connection, onClose, projectId, query, recordRecent, threadId],
  );

  const useRecent = useCallback((value: string) => {
    setQuery(value);
    inputRef.current?.focus();
  }, []);

  const showRecents = query.trim().length === 0;
  const hits = state.hits;
  const lastHitIndex = Math.max(0, hits.length - 1);

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (showRecents || hits.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightedIndex((index) => Math.min(lastHitIndex, index + 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightedIndex((index) => Math.max(0, index - 1));
      } else if (event.key === "Enter") {
        event.preventDefault();
        const hit = hits[highlightedIndex];
        if (hit) openHit(hit);
      }
    },
    [hits, highlightedIndex, lastHitIndex, onClose, openHit, showRecents],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search vault"
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[14vh]"
    >
      <button
        type="button"
        aria-label="Close search"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/30 backdrop-blur-[1px]"
      />
      <div className="relative flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl shadow-black/30">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Search notes in vault…"
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground/70"
            aria-label="Search vault notes"
          />
          <Kbd className="text-[10px]">Esc</Kbd>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {showRecents ? (
            <RecentSearchesList recents={recents} onPick={useRecent} />
          ) : state.status === "error" ? (
            <div className="px-4 py-6 text-sm text-destructive">
              {state.error ?? "Search failed."}
            </div>
          ) : state.status === "loading" && hits.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">Searching…</div>
          ) : hits.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              No matches for &ldquo;{query.trim()}&rdquo;.
            </div>
          ) : (
            <ul role="listbox" className="flex flex-col py-1">
              {hits.map((hit, index) => (
                <li key={hit.relativePath} role="option" aria-selected={index === highlightedIndex}>
                  <button
                    type="button"
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => openHit(hit)}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left",
                      index === highlightedIndex ? "bg-accent/60" : "hover:bg-accent/40",
                    )}
                  >
                    <div className="flex w-full items-center gap-2">
                      <FileTextIcon
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-muted-foreground/80"
                      />
                      <span className="truncate text-sm font-medium text-foreground">
                        {noteHitTitle(hit)}
                      </span>
                      <span className="ml-auto truncate text-xs text-muted-foreground/70">
                        {hit.relativePath}
                      </span>
                    </div>
                    {hit.snippet ? (
                      <span
                        className="line-clamp-2 pl-[1.375rem] text-xs text-muted-foreground"
                        dangerouslySetInnerHTML={{ __html: hit.snippet }}
                      />
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between border-t border-border bg-card/40 px-4 py-1.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <Kbd className="text-[10px]">↑</Kbd>
              <Kbd className="text-[10px]">↓</Kbd>
              <span>navigate</span>
            </span>
            <span className="flex items-center gap-1">
              <Kbd className="text-[10px]">Enter</Kbd>
              <span>open</span>
            </span>
          </div>
          <span className="text-muted-foreground/70">
            {state.status === "loaded" ? `${hits.length} results` : null}
          </span>
        </div>
      </div>
    </div>
  );
}

interface RecentSearchesListProps {
  readonly recents: ReadonlyArray<string>;
  readonly onPick: (value: string) => void;
}

function RecentSearchesList({ recents, onPick }: RecentSearchesListProps) {
  if (recents.length === 0) {
    return (
      <div className="px-4 py-6 text-sm text-muted-foreground">
        Start typing to search across all notes in the vault.
      </div>
    );
  }
  return (
    <div className="flex flex-col py-1">
      <div className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">
        Recent
      </div>
      <ul role="list" className="flex flex-col">
        {recents.map((entry) => (
          <li key={entry}>
            <button
              type="button"
              onClick={() => onPick(entry)}
              className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm hover:bg-accent/40"
            >
              <ClockIcon
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground/70"
              />
              <span className="truncate text-foreground/90">{entry}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
