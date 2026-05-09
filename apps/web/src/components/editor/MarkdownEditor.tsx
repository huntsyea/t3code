import {
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type ThreadTabState,
} from "@t3tools/contracts";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { bracketMatching, foldGutter, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { CircleAlertIcon, FileWarningIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentConnection } from "../../environments/runtime";
import { cn } from "~/lib/utils";
import { toastManager } from "../ui/toast";
import { livePreviewExtensions } from "./livePreview";
import { wikilinkAutocomplete } from "./wikilinkAutocomplete";
import { wikilinkNavigate, wikilinkNavigateTheme } from "./wikilinkNavigate";

const AUTOSAVE_DEBOUNCE_MS = 2000;

interface MarkdownEditorProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly relativePath: string;
  readonly className?: string;
}

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly initialContent: string }
  | { readonly status: "error"; readonly message: string; readonly missing: boolean };

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "14px",
  },
  ".cm-scroller": {
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    lineHeight: "1.6",
    padding: "16px 0",
  },
  ".cm-content": {
    caretColor: "var(--foreground)",
    padding: "0 24px",
    maxWidth: "min(100ch, 100%)",
    margin: "0 auto",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    border: "none",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--accent) 35%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in srgb, var(--accent) 35%, transparent)",
  },
  "&.cm-focused": {
    outline: "none",
  },
});

function formatErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  return fallback;
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "NOT_FOUND";
}

export function MarkdownEditor({
  environmentId,
  threadId,
  projectId,
  relativePath,
  className,
}: MarkdownEditorProps) {
  const connection = readEnvironmentConnection(environmentId);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastSavedContentRef = useRef<string>("");
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSavingRef = useRef(false);
  const dirtyRef = useRef(false);

  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [isDirty, setIsDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const updateNoteTabDirty = useCallback(
    async (nextDirty: boolean) => {
      if (!connection) return;
      try {
        const state = await connection.client.tabs.getThreadState({ threadId });
        if (!state) return;
        let mutated = false;
        const nextTabs = state.tabs.map((tab) => {
          if (
            tab.kind === "note" &&
            tab.vaultId === projectId &&
            tab.relativePath === relativePath &&
            tab.isDirty !== nextDirty
          ) {
            mutated = true;
            return { ...tab, isDirty: nextDirty };
          }
          return tab;
        });
        if (!mutated) return;
        const nextState: ThreadTabState = {
          ...state,
          tabs: nextTabs,
        };
        await connection.client.tabs.setThreadState({ threadId, state: nextState });
      } catch {
        // Tab dirty mirroring is best-effort; the editor's own state stays authoritative.
      }
    },
    [connection, projectId, relativePath, threadId],
  );

  const cancelAutoSaveTimer = useCallback(() => {
    if (autoSaveTimerRef.current !== null) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, []);

  const performSave = useCallback(async () => {
    if (!connection) return;
    const view = viewRef.current;
    if (!view) return;
    if (isSavingRef.current) return;
    const content = view.state.doc.toString();
    if (content === lastSavedContentRef.current && !dirtyRef.current) return;

    cancelAutoSaveTimer();
    isSavingRef.current = true;
    try {
      await connection.client.vault.writeNote({ projectId, relativePath, content });
      lastSavedContentRef.current = content;
      const stillMatches = viewRef.current?.state.doc.toString() === content;
      if (stillMatches) {
        dirtyRef.current = false;
        setIsDirty(false);
        void updateNoteTabDirty(false);
      }
      setSaveError(null);
      toastManager.add({
        type: "success",
        title: "Saved",
        description: relativePath,
      });
    } catch (error) {
      const message = formatErrorMessage(error, "Failed to save note.");
      setSaveError(message);
      toastManager.add({
        type: "error",
        title: "Failed to save note",
        description: message,
      });
    } finally {
      isSavingRef.current = false;
    }
  }, [cancelAutoSaveTimer, connection, projectId, relativePath, updateNoteTabDirty]);

  const scheduleAutoSave = useCallback(() => {
    cancelAutoSaveTimer();
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null;
      void performSave();
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [cancelAutoSaveTimer, performSave]);

  useEffect(() => {
    if (!connection) {
      setLoadState({
        status: "error",
        message: "No connection to the environment.",
        missing: false,
      });
      return;
    }

    let cancelled = false;
    setLoadState({ status: "loading" });

    connection.client.vault
      .readNote({ projectId, relativePath })
      .then((result) => {
        if (cancelled) return;
        lastSavedContentRef.current = result.content;
        dirtyRef.current = false;
        setIsDirty(false);
        setSaveError(null);
        setLoadState({ status: "ready", initialContent: result.content });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const missing = isNotFoundError(error);
        setLoadState({
          status: "error",
          message: missing
            ? "This file was deleted on disk."
            : formatErrorMessage(error, "Failed to load note."),
          missing,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [connection, projectId, relativePath]);

  useEffect(() => {
    if (loadState.status !== "ready") return;
    const container = containerRef.current;
    if (!container) return;

    const saveKeymap = keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          void performSave();
          return true;
        },
      },
    ]);

    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const content = update.state.doc.toString();
      const nextDirty = content !== lastSavedContentRef.current;
      if (nextDirty !== dirtyRef.current) {
        dirtyRef.current = nextDirty;
        setIsDirty(nextDirty);
        void updateNoteTabDirty(nextDirty);
      }
      if (nextDirty) {
        scheduleAutoSave();
      } else {
        cancelAutoSaveTimer();
      }
    });

    const wikilinkAutocompleteExtension = connection
      ? wikilinkAutocomplete({
          loadBasenames: async () => {
            const result = await connection.client.vault.listEntries({
              projectId,
              relativeDir: "",
            });
            return result.entries
              .filter((entry) => entry.kind === "file" && entry.name.toLowerCase().endsWith(".md"))
              .map((entry) => entry.name.slice(0, -".md".length));
          },
        })
      : null;

    const wikilinkNavigateExtension = connection
      ? wikilinkNavigate({
          resolveBasename: async (basename) => {
            const result = await connection.client.vault.resolveBasename({
              projectId,
              basename,
            });
            const first = result.matches[0];
            if (!first) {
              return { basename, status: "broken", relativePath: null };
            }
            if (result.matches.length > 1) {
              toastManager.add({
                type: "info",
                title: `Multiple notes named ${basename}`,
                description: `Opened most recent: ${first.relativePath}`,
              });
            }
            return { basename, status: "resolved", relativePath: first.relativePath };
          },
          openNote: async ({ relativePath: targetRelativePath }) => {
            await connection.client.tabs.openNoteTab({
              threadId,
              vaultId: projectId,
              relativePath: targetRelativePath,
            });
          },
          createNote: async (basename) => {
            const confirmed =
              typeof window === "undefined" ? false : window.confirm(`Create note "${basename}"?`);
            if (!confirmed) return null;
            const targetRelativePath = `${basename}.md`;
            try {
              await connection.client.vault.writeNote({
                projectId,
                relativePath: targetRelativePath,
                content: "",
              });
              return targetRelativePath;
            } catch (error) {
              toastManager.add({
                type: "error",
                title: "Failed to create note",
                description: formatErrorMessage(error, "Unknown error."),
              });
              return null;
            }
          },
        })
      : null;

    const state = EditorState.create({
      doc: loadState.initialContent,
      extensions: [
        lineNumbers(),
        foldGutter(),
        history(),
        drawSelection(),
        bracketMatching(),
        indentOnInput(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        markdown(),
        ...livePreviewExtensions,
        ...(wikilinkNavigateExtension ? [wikilinkNavigateExtension, wikilinkNavigateTheme] : []),
        ...(wikilinkAutocompleteExtension ? [wikilinkAutocompleteExtension] : []),
        editorTheme,
        saveKeymap,
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        updateListener,
      ],
    });

    const view = new EditorView({ state, parent: container });
    viewRef.current = view;

    return () => {
      cancelAutoSaveTimer();
      if (dirtyRef.current && viewRef.current) {
        const content = viewRef.current.state.doc.toString();
        if (connection && content !== lastSavedContentRef.current) {
          void connection.client.vault
            .writeNote({ projectId, relativePath, content })
            .catch(() => undefined);
        }
      }
      view.destroy();
      viewRef.current = null;
    };
  }, [
    cancelAutoSaveTimer,
    connection,
    loadState,
    performSave,
    projectId,
    relativePath,
    scheduleAutoSave,
    updateNoteTabDirty,
  ]);

  const statusLabel = useMemo(() => {
    if (saveError) return "Save failed";
    if (isSavingRef.current) return "Saving…";
    if (isDirty) return "Unsaved";
    return "Saved";
  }, [isDirty, saveError]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      {loadState.status === "error" ? (
        <div
          role="alert"
          className={cn(
            "flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm",
            "text-amber-700 dark:text-amber-300",
          )}
        >
          {loadState.missing ? (
            <FileWarningIcon className="size-4 shrink-0" />
          ) : (
            <CircleAlertIcon className="size-4 shrink-0" />
          )}
          <span className="truncate">{loadState.message}</span>
        </div>
      ) : null}
      {saveError && loadState.status === "ready" ? (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive"
        >
          <CircleAlertIcon className="size-4 shrink-0" />
          <span className="truncate">{saveError}</span>
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {loadState.status === "loading" ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            Loading note…
          </div>
        ) : null}
        <div
          ref={containerRef}
          className={cn(
            "h-full w-full overflow-auto bg-background",
            loadState.status === "ready" ? "block" : "hidden",
          )}
        />
      </div>
      <div className="flex shrink-0 items-center justify-between border-t border-border bg-card/50 px-4 py-1.5 text-xs text-muted-foreground">
        <span className="truncate">{relativePath}</span>
        <span
          className={cn(
            "font-medium",
            saveError ? "text-destructive" : isDirty ? "text-amber-600 dark:text-amber-400" : null,
          )}
        >
          {statusLabel}
        </span>
      </div>
    </div>
  );
}
