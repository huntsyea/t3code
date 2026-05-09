// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import {
  type ProjectId,
  type VaultFileEvent,
  type VaultIndexUpdate,
  VaultWatcherError,
} from "@t3tools/contracts";
import { parseTags } from "@t3tools/shared/markdown/tag";
import { parseWikilinks } from "@t3tools/shared/markdown/wikilink";
import { type DrainableWorker, makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { VaultIndex } from "../../vault/VaultIndex.ts";
import { VaultWatcher } from "../../vault/VaultWatcher.ts";
import {
  VaultIndexReactor,
  type VaultIndexReactorShape,
  type VaultIndexUpdateHandler,
} from "../Services/VaultIndexReactor.ts";

const NOTE_FILE_EXTENSION = ".md";
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const HEADING_PATTERN = /^\s*#\s+(.+?)\s*$/m;

class VaultIndexFsError extends Data.TaggedError("VaultIndexFsError")<{
  readonly relativePath: string;
  readonly cause: unknown;
}> {}

interface ParsedFrontmatter {
  readonly title: string | null;
  readonly tagsRaw: Record<string, unknown> | undefined;
  readonly raw: string | null;
}

const stripQuotes = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
};

const parseFrontmatterTags = (rawTagsLine: string): Array<string> => {
  const trimmed = rawTagsLine.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1);
    return inner
      .split(",")
      .map((piece) => stripQuotes(piece))
      .filter((piece) => piece.length > 0);
  }
  if (trimmed.length === 0) return [];
  return trimmed
    .split(",")
    .map((piece) => stripQuotes(piece))
    .filter((piece) => piece.length > 0);
};

const parseFrontmatter = (content: string): ParsedFrontmatter => {
  const match = FRONTMATTER_PATTERN.exec(content);
  if (!match) {
    return { title: null, tagsRaw: undefined, raw: null };
  }
  const body = match[1] ?? "";
  let title: string | null = null;
  const tags: Array<string> = [];
  let inListTags = false;
  for (const line of body.split(/\r?\n/)) {
    if (inListTags) {
      const listMatch = /^\s*-\s+(.+)$/.exec(line);
      if (listMatch) {
        const value = stripQuotes(listMatch[1]!);
        if (value.length > 0) tags.push(value);
        continue;
      }
      inListTags = false;
    }
    const titleMatch = /^title\s*:\s*(.*)$/i.exec(line);
    if (titleMatch && title === null) {
      const value = stripQuotes(titleMatch[1] ?? "");
      title = value.length > 0 ? value : null;
      continue;
    }
    const tagsMatch = /^tags\s*:\s*(.*)$/i.exec(line);
    if (tagsMatch) {
      const after = tagsMatch[1] ?? "";
      if (after.trim().length === 0) {
        inListTags = true;
      } else {
        tags.push(...parseFrontmatterTags(after));
      }
    }
  }
  return {
    title,
    tagsRaw: tags.length > 0 ? { tags } : undefined,
    raw: body,
  };
};

const extractTitleFromContent = (content: string): string | null => {
  const stripped = content.replace(FRONTMATTER_PATTERN, "");
  const match = HEADING_PATTERN.exec(stripped);
  if (match && match[1]) return match[1].trim();
  return null;
};

const basenameFromRelativePath = (relativePath: string): string => {
  const base = relativePath.split("/").pop() ?? relativePath;
  return base.endsWith(NOTE_FILE_EXTENSION) ? base.slice(0, -NOTE_FILE_EXTENSION.length) : base;
};

const isHiddenSegment = (relativePath: string): boolean =>
  relativePath.split("/").some((segment) => segment.length > 0 && segment.startsWith("."));

interface ProjectReactorEntry {
  readonly projectId: ProjectId;
  readonly vaultRoot: string;
  readonly listeners: Set<VaultIndexUpdateHandler>;
  readonly worker: DrainableWorker<VaultFileEvent>;
  readonly initialScanWorker: DrainableWorker<string>;
  readonly unsubscribe: () => void;
  readonly entryScope: Scope.Closeable;
}

const make = Effect.gen(function* () {
  const vaultIndex = yield* VaultIndex;
  const vaultWatcher = yield* VaultWatcher;
  const projects = yield* ProjectionProjectRepository;

  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  const entriesRef = yield* SynchronizedRef.make(new Map<ProjectId, ProjectReactorEntry>());

  const dispatchUpdate = (
    entry: ProjectReactorEntry,
    update: VaultIndexUpdate,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const handlers = Array.from(entry.listeners);
      for (const handler of handlers) {
        yield* handler(update).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("vault index reactor subscriber threw while handling update", {
              projectId: entry.projectId,
              relativePath: update.relativePath,
              error,
            }),
          ),
          Effect.ignore,
        );
      }
    });

  const readNoteFile = (
    absolutePath: string,
    relativePath: string,
  ): Effect.Effect<
    Option.Option<{ readonly content: string; readonly mtimeMs: number; readonly size: number }>
  > =>
    Effect.tryPromise({
      try: async () => {
        const stat = await fs.stat(absolutePath);
        const content = await fs.readFile(absolutePath, "utf8");
        return { content, mtimeMs: stat.mtimeMs, size: stat.size };
      },
      catch: (cause) => new VaultIndexFsError({ relativePath, cause }),
    }).pipe(
      Effect.map(Option.some),
      Effect.catchTag("VaultIndexFsError", () =>
        Effect.succeed(
          Option.none<{
            readonly content: string;
            readonly mtimeMs: number;
            readonly size: number;
          }>(),
        ),
      ),
    );

  const indexFile = (entry: ProjectReactorEntry, relativePath: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (isHiddenSegment(relativePath)) return;
      if (!relativePath.toLowerCase().endsWith(NOTE_FILE_EXTENSION)) return;

      const absolutePath = nodePath.join(entry.vaultRoot, relativePath);
      const fileOption = yield* readNoteFile(absolutePath, relativePath);
      if (Option.isNone(fileOption)) return;

      const { content: text, mtimeMs, size } = fileOption.value;
      const frontmatter = parseFrontmatter(text);
      const headingTitle = extractTitleFromContent(text);
      const title = frontmatter.title ?? headingTitle ?? basenameFromRelativePath(relativePath);

      const wikilinks = parseWikilinks(text).map((match) => ({
        targetBasename: match.basename,
        spanStart: match.span[0],
        spanEnd: match.span[1],
      }));
      const tags = parseTags(text, frontmatter.tagsRaw).map((tag) => tag.tag);
      const frontmatterJson = frontmatter.raw ? JSON.stringify({ raw: frontmatter.raw }) : null;

      yield* vaultIndex
        .upsertNote(entry.projectId, relativePath, {
          title,
          mtime: Math.floor(mtimeMs),
          size,
          frontmatterJson,
          body: text,
        })
        .pipe(
          Effect.tapError((error) =>
            Effect.logWarning("vault index reactor failed to upsert note", {
              projectId: entry.projectId,
              relativePath,
              error,
            }),
          ),
          Effect.ignore,
        );

      yield* vaultIndex.upsertWikilinks(entry.projectId, relativePath, wikilinks).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("vault index reactor failed to upsert wikilinks", {
            projectId: entry.projectId,
            relativePath,
            error,
          }),
        ),
        Effect.ignore,
      );

      yield* vaultIndex.upsertTags(entry.projectId, relativePath, tags).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("vault index reactor failed to upsert tags", {
            projectId: entry.projectId,
            relativePath,
            error,
          }),
        ),
        Effect.ignore,
      );

      yield* dispatchUpdate(entry, {
        projectId: entry.projectId,
        kind: "upserted",
        relativePath,
      });
    });

  const removeFile = (entry: ProjectReactorEntry, relativePath: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* vaultIndex.deleteNote(entry.projectId, relativePath).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("vault index reactor failed to delete note", {
            projectId: entry.projectId,
            relativePath,
            error,
          }),
        ),
        Effect.ignore,
      );
      yield* dispatchUpdate(entry, {
        projectId: entry.projectId,
        kind: "removed",
        relativePath,
      });
    });

  const processEvent =
    (entry: ProjectReactorEntry) =>
    (event: VaultFileEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        switch (event.kind) {
          case "added":
          case "changed":
            yield* indexFile(entry, event.relativePath);
            return;
          case "removed":
            yield* removeFile(entry, event.relativePath);
            return;
          case "renamed": {
            if (event.oldRelativePath) {
              yield* removeFile(entry, event.oldRelativePath);
            }
            yield* indexFile(entry, event.relativePath);
            return;
          }
        }
      });

  const enumerateMarkdownFiles = (
    vaultRoot: string,
  ): Effect.Effect<ReadonlyArray<string>, VaultWatcherError> =>
    Effect.tryPromise({
      try: () => fs.readdir(vaultRoot, { withFileTypes: true, recursive: true }),
      catch: (cause) =>
        new VaultWatcherError({
          code: "WATCH_FAILED",
          message: `Failed to read vault root for initial scan: ${vaultRoot}`,
          cause,
        }),
    }).pipe(
      Effect.map((dirents) => {
        const collected: Array<string> = [];
        for (const dirent of dirents) {
          if (!dirent.isFile()) continue;
          const fullPath = nodePath.join(dirent.parentPath ?? vaultRoot, dirent.name);
          const rel = nodePath.relative(vaultRoot, fullPath).split(nodePath.sep).join("/");
          if (rel.length === 0) continue;
          if (isHiddenSegment(rel)) continue;
          if (!rel.toLowerCase().endsWith(NOTE_FILE_EXTENSION)) continue;
          collected.push(rel);
        }
        return collected as ReadonlyArray<string>;
      }),
    );

  const buildEntry = (projectId: ProjectId, vaultRoot: string) =>
    Effect.gen(function* () {
      const listeners = new Set<VaultIndexUpdateHandler>();
      const entryRef: { current: ProjectReactorEntry | null } = { current: null };
      const entryScope = yield* Scope.make("sequential");

      const worker = yield* makeDrainableWorker<VaultFileEvent, never, never>((event) =>
        entryRef.current ? processEvent(entryRef.current)(event) : Effect.void,
      ).pipe(Scope.provide(entryScope));

      const initialScanWorker = yield* makeDrainableWorker<string, never, never>((relativePath) =>
        entryRef.current ? indexFile(entryRef.current, relativePath) : Effect.void,
      ).pipe(Scope.provide(entryScope));

      const unsubscribe = yield* vaultWatcher.subscribe(projectId, (event) =>
        entryRef.current ? worker.enqueue(event) : Effect.void,
      );

      const entry: ProjectReactorEntry = {
        projectId,
        vaultRoot,
        listeners,
        worker,
        initialScanWorker,
        unsubscribe,
        entryScope,
      };
      entryRef.current = entry;

      const initialScan = Effect.gen(function* () {
        const files = yield* enumerateMarkdownFiles(vaultRoot).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("vault index reactor initial scan enumeration failed", {
              projectId,
              vaultRoot,
              error,
            }),
          ),
          Effect.orElseSucceed<ReadonlyArray<string>>(() => []),
        );
        for (const relativePath of files) {
          yield* initialScanWorker.enqueue(relativePath);
        }
      });

      runFork(initialScan);

      return entry;
    });

  const ensureEntry = (projectId: ProjectId, vaultRoot: string) =>
    SynchronizedRef.modifyEffect(entriesRef, (entries) => {
      const existing = entries.get(projectId);
      if (existing) {
        return Effect.succeed([existing, entries] as const);
      }
      return buildEntry(projectId, vaultRoot).pipe(
        Effect.map((entry) => {
          const next = new Map(entries);
          next.set(projectId, entry);
          return [entry, next] as const;
        }),
      );
    });

  const startVaultProjects = Effect.gen(function* () {
    const allProjects = yield* projects.listAll().pipe(
      Effect.tapError((error) =>
        Effect.logWarning("vault index reactor failed to load project list at startup", {
          error,
        }),
      ),
      Effect.orElseSucceed(() => [] as ReadonlyArray<never>),
    );
    for (const project of allProjects) {
      if (project.kind !== "vault") continue;
      if (project.deletedAt !== null) continue;
      yield* vaultWatcher.start(project.projectId, project.workspaceRoot).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("vault index reactor failed to start watcher for project", {
            projectId: project.projectId,
            error,
          }),
        ),
        Effect.ignore,
      );
      yield* ensureEntry(project.projectId, project.workspaceRoot).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("vault index reactor failed to bootstrap project entry", {
            projectId: project.projectId,
            error,
          }),
        ),
        Effect.ignore,
      );
    }
  });

  const start: VaultIndexReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(startVaultProjects);
  });

  const drain: VaultIndexReactorShape["drain"] = Effect.gen(function* () {
    const entries = yield* SynchronizedRef.get(entriesRef);
    for (const entry of entries.values()) {
      yield* entry.initialScanWorker.drain;
      yield* entry.worker.drain;
    }
  });

  const subscribe: VaultIndexReactorShape["subscribe"] = (projectId, handler) =>
    Effect.gen(function* () {
      const projectOption = yield* projects.getById({ projectId }).pipe(
        Effect.mapError(
          (cause) =>
            new VaultWatcherError({
              code: "PROJECT_NOT_FOUND",
              message: `Failed to load project ${projectId}`,
              cause,
            }),
        ),
      );
      if (Option.isNone(projectOption)) {
        return yield* new VaultWatcherError({
          code: "PROJECT_NOT_FOUND",
          message: `Project ${projectId} was not found`,
        });
      }
      const project = projectOption.value;
      if (project.kind !== "vault") {
        return yield* new VaultWatcherError({
          code: "KIND_MISMATCH",
          message: `Project ${projectId} is not a vault (kind=${project.kind ?? "code"})`,
        });
      }

      yield* vaultWatcher.start(projectId, project.workspaceRoot);
      const entry = yield* ensureEntry(projectId, project.workspaceRoot);
      entry.listeners.add(handler);

      return (): void => {
        runFork(
          Effect.sync(() => {
            entry.listeners.delete(handler);
          }),
        );
      };
    });

  const finalizeEntry = (entry: ProjectReactorEntry): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* entry.worker.drain;
      yield* entry.initialScanWorker.drain;
      entry.unsubscribe();
      yield* Scope.close(entry.entryScope, Exit.void).pipe(Effect.ignore);
    });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const entries = yield* SynchronizedRef.getAndUpdate(entriesRef, () => new Map());
      for (const entry of entries.values()) {
        yield* finalizeEntry(entry);
      }
    }),
  );

  return {
    start,
    drain,
    subscribe,
  } satisfies VaultIndexReactorShape;
});

export const VaultIndexReactorLive = Layer.effect(VaultIndexReactor, make);
