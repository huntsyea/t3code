import {
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type VaultTagCount,
  type VaultTaggedNote,
} from "@t3tools/contracts";
import { ChevronRightIcon, FileTextIcon, HashIcon, TagIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentConnection } from "../../environments/runtime";
import { cn } from "~/lib/utils";

interface TagBrowserProps {
  threadId: ThreadId;
  environmentId: EnvironmentId;
  projectId: ProjectId;
}

interface TagNode {
  readonly segment: string;
  readonly fullTag: string | null;
  readonly count: number;
  readonly children: TagNode[];
}

interface NoteListState {
  status: "idle" | "loading" | "loaded" | "error";
  notes: ReadonlyArray<VaultTaggedNote>;
  error?: string;
}

function buildTagTree(tags: ReadonlyArray<VaultTagCount>): TagNode[] {
  const root: TagNode = { segment: "", fullTag: null, count: 0, children: [] };
  const nodesByPath = new Map<string, TagNode>();

  const ensureChild = (parent: TagNode, segment: string, fullTag: string): TagNode => {
    const existing = parent.children.find((child) => child.segment === segment);
    if (existing) return existing;
    const node: TagNode = { segment, fullTag, count: 0, children: [] };
    parent.children.push(node);
    nodesByPath.set(fullTag, node);
    return node;
  };

  for (const { tag, count } of tags) {
    const parts = tag.split("/").filter((part: string) => part.length > 0);
    if (parts.length === 0) continue;
    let cursor = root;
    let pathAccumulator = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      pathAccumulator = pathAccumulator.length === 0 ? part : `${pathAccumulator}/${part}`;
      cursor = ensureChild(cursor, part, pathAccumulator);
      if (i === parts.length - 1) {
        const node = nodesByPath.get(pathAccumulator);
        if (node) {
          (node as { count: number }).count = count;
        }
      }
    }
  }

  sortTreeRecursive(root);
  return root.children;
}

function sortTreeRecursive(node: TagNode): void {
  node.children.sort((a, b) =>
    a.segment.localeCompare(b.segment, undefined, { sensitivity: "base" }),
  );
  for (const child of node.children) sortTreeRecursive(child);
}

function noteDisplayName(note: VaultTaggedNote): string {
  if (note.title && note.title.trim().length > 0) return note.title;
  const base = note.relativePath.split("/").pop() ?? note.relativePath;
  return base.endsWith(".md") ? base.slice(0, -".md".length) : base;
}

export const TagBrowser = memo(function TagBrowser({
  threadId,
  environmentId,
  projectId,
}: TagBrowserProps) {
  const connection = readEnvironmentConnection(environmentId);
  const [tags, setTags] = useState<ReadonlyArray<VaultTagCount>>([]);
  const [tagsStatus, setTagsStatus] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [expandedTags, setExpandedTags] = useState<Record<string, boolean>>({});
  const [notesByTag, setNotesByTag] = useState<Record<string, NoteListState>>({});
  const inFlightTagNotes = useRef<Set<string>>(new Set());

  const loadTags = useCallback(async () => {
    if (!connection) return;
    setTagsStatus((prev) => (prev === "loaded" ? prev : "loading"));
    try {
      const result = await connection.client.vault.listTags({ projectId });
      setTags(result.tags);
      setTagsStatus("loaded");
      setTagsError(null);
    } catch (error) {
      setTagsStatus("error");
      setTagsError(error instanceof Error ? error.message : "Failed to load tags");
    }
  }, [connection, projectId]);

  const loadNotesByTag = useCallback(
    async (tag: string) => {
      if (!connection) return;
      if (inFlightTagNotes.current.has(tag)) return;
      inFlightTagNotes.current.add(tag);
      setNotesByTag((current) => ({
        ...current,
        [tag]: {
          status: "loading",
          notes: current[tag]?.notes ?? [],
        },
      }));
      try {
        const result = await connection.client.vault.notesByTag({ projectId, tag });
        setNotesByTag((current) => ({
          ...current,
          [tag]: { status: "loaded", notes: result.notes },
        }));
      } catch (error) {
        setNotesByTag((current) => ({
          ...current,
          [tag]: {
            status: "error",
            notes: current[tag]?.notes ?? [],
            error: error instanceof Error ? error.message : "Failed to load notes",
          },
        }));
      } finally {
        inFlightTagNotes.current.delete(tag);
      }
    },
    [connection, projectId],
  );

  useEffect(() => {
    setTags([]);
    setTagsStatus("idle");
    setExpandedTags({});
    setNotesByTag({});
    inFlightTagNotes.current.clear();
    void loadTags();
  }, [projectId, loadTags]);

  const tree = useMemo(() => buildTagTree(tags), [tags]);

  const toggleTag = useCallback(
    (fullTag: string) => {
      setExpandedTags((current) => {
        const wasOpen = Boolean(current[fullTag]);
        if (!wasOpen) {
          const state = notesByTag[fullTag];
          if (!state || state.status === "idle") {
            void loadNotesByTag(fullTag);
          }
        }
        return { ...current, [fullTag]: !wasOpen };
      });
    },
    [loadNotesByTag, notesByTag],
  );

  const openNote = useCallback(
    (note: VaultTaggedNote) => {
      if (!connection) return;
      void connection.client.tabs.openNoteTab({
        threadId,
        vaultId: projectId,
        relativePath: note.relativePath,
      });
    },
    [connection, projectId, threadId],
  );

  return (
    <div className="border-t border-border" data-testid="tag-browser">
      <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <TagIcon aria-hidden="true" className="size-3" />
        Tags
      </div>
      {tagsStatus === "loading" && tags.length === 0 ? (
        <div className="px-3 pb-2 text-xs text-muted-foreground">Loading…</div>
      ) : tagsStatus === "error" ? (
        <div className="px-3 pb-2 text-xs text-destructive">
          {tagsError ?? "Failed to load tags."}
        </div>
      ) : tree.length === 0 ? (
        <div className="px-3 pb-2 text-xs text-muted-foreground">No tags yet</div>
      ) : (
        <div className="flex flex-col pb-2" role="tree" aria-label="Tags">
          {tree.map((node) => (
            <TagTreeNode
              key={node.fullTag ?? node.segment}
              node={node}
              depth={0}
              expandedTags={expandedTags}
              notesByTag={notesByTag}
              onToggle={toggleTag}
              onOpenNote={openNote}
            />
          ))}
        </div>
      )}
    </div>
  );
});

interface TagTreeNodeProps {
  node: TagNode;
  depth: number;
  expandedTags: Record<string, boolean>;
  notesByTag: Record<string, NoteListState>;
  onToggle: (fullTag: string) => void;
  onOpenNote: (note: VaultTaggedNote) => void;
}

const TagTreeNode = memo(function TagTreeNode({
  node,
  depth,
  expandedTags,
  notesByTag,
  onToggle,
  onOpenNote,
}: TagTreeNodeProps) {
  if (!node.fullTag) return null;
  const fullTag = node.fullTag;
  const isExpanded = Boolean(expandedTags[fullTag]);
  const hasChildren = node.children.length > 0;
  const noteState = notesByTag[fullTag];
  const leftPadding = 8 + depth * 14;

  return (
    <div role="treeitem" aria-expanded={isExpanded} aria-level={depth + 1}>
      <button
        type="button"
        onClick={() => onToggle(fullTag)}
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
        <HashIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground/80" />
        <span className="truncate text-foreground/90">{node.segment}</span>
        {node.count > 0 ? (
          <span className="ml-auto text-xs text-muted-foreground/70">{node.count}</span>
        ) : null}
      </button>
      {isExpanded ? (
        <div role="group">
          {noteState?.status === "loading" && noteState.notes.length === 0 ? (
            <div
              className="py-1 pr-2 text-xs text-muted-foreground"
              style={{ paddingLeft: `${leftPadding + 22}px` }}
            >
              Loading…
            </div>
          ) : noteState?.status === "error" ? (
            <div
              className="py-1 pr-2 text-xs text-destructive"
              style={{ paddingLeft: `${leftPadding + 22}px` }}
            >
              {noteState.error ?? "Failed to load notes"}
            </div>
          ) : noteState && noteState.notes.length === 0 ? (
            <div
              className="py-1 pr-2 text-xs text-muted-foreground"
              style={{ paddingLeft: `${leftPadding + 22}px` }}
            >
              No notes
            </div>
          ) : (
            noteState?.notes.map((note) => (
              <button
                key={note.relativePath}
                type="button"
                onClick={() => onOpenNote(note)}
                className="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-sm hover:bg-accent/50"
                style={{ paddingLeft: `${leftPadding + 22}px` }}
              >
                <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
                <span className="truncate text-foreground/90">{noteDisplayName(note)}</span>
              </button>
            ))
          )}
          {hasChildren ? (
            <div role="group">
              {node.children.map((child) => (
                <TagTreeNode
                  key={child.fullTag ?? child.segment}
                  node={child}
                  depth={depth + 1}
                  expandedTags={expandedTags}
                  notesByTag={notesByTag}
                  onToggle={onToggle}
                  onOpenNote={onOpenNote}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
