// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeTimers from "node:timers";

import {
  type ProjectId,
  type VaultFileEvent,
  type VaultFileEventKind,
  VaultWatcherError,
} from "@t3tools/contracts";
import { type DrainableWorker, makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as chokidar from "chokidar";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ignoredVaultWatchPatterns } from "./vaultIgnore.ts";

export const VAULT_WATCHER_DEBOUNCE_MS = 250;
export const VAULT_WATCHER_AWAIT_WRITE_FINISH_MS = 100;
const NOTE_FILE_EXTENSION = ".md";

export type VaultFileEventHandler = (event: VaultFileEvent) => Effect.Effect<void>;

export type ChokidarFactory = (
  paths: string,
  options: chokidar.ChokidarOptions,
) => chokidar.FSWatcher;

export interface VaultWatcherShape {
  readonly start: (
    projectId: ProjectId,
    vaultRoot: string,
  ) => Effect.Effect<void, VaultWatcherError>;
  readonly stop: (projectId: ProjectId) => Effect.Effect<void>;
  readonly subscribe: (
    projectId: ProjectId,
    handler: VaultFileEventHandler,
  ) => Effect.Effect<() => void, VaultWatcherError>;
}

export class VaultWatcher extends Context.Service<VaultWatcher, VaultWatcherShape>()(
  "t3/vault/VaultWatcher",
) {}

interface ProjectWatcherEntry {
  readonly projectId: ProjectId;
  readonly vaultRoot: string;
  readonly watcher: chokidar.FSWatcher;
  readonly listeners: Set<VaultFileEventHandler>;
  readonly worker: DrainableWorker<ReadonlyArray<VaultFileEvent>>;
  readonly entryScope: Scope.Closeable;
  pending: Map<string, VaultFileEvent>;
  flushTimer: ReturnType<typeof NodeTimers.setTimeout> | null;
}

export interface VaultWatcherFactoryOptions {
  readonly debounceMs?: number;
  readonly awaitWriteFinishMs?: number;
  readonly chokidarFactory?: ChokidarFactory;
}

const toPosix = (value: string): string => value.replaceAll("\\", "/");

const toPosixRelative = (vaultRoot: string, absolutePath: string): string => {
  const root = toPosix(vaultRoot);
  const abs = toPosix(absolutePath);
  if (abs === root) return "";
  if (abs.startsWith(`${root}/`)) {
    return abs.slice(root.length + 1);
  }
  if (process.platform === "darwin") {
    const lowerRoot = root.toLowerCase();
    const lowerAbs = abs.toLowerCase();
    if (lowerAbs.startsWith(`${lowerRoot}/`)) {
      return abs.slice(root.length + 1);
    }
  }
  return "";
};

const eventKindFor = (chokidarEvent: string): VaultFileEventKind | null => {
  switch (chokidarEvent) {
    case "add":
      return "added";
    case "change":
      return "changed";
    case "unlink":
      return "removed";
    default:
      return null;
  }
};

export const makeVaultWatcherWithOptions = (options: VaultWatcherFactoryOptions = {}) =>
  Effect.gen(function* () {
    const projects = yield* ProjectionProjectRepository;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const debounceMs = options.debounceMs ?? VAULT_WATCHER_DEBOUNCE_MS;
    const awaitWriteFinishMs = options.awaitWriteFinishMs ?? VAULT_WATCHER_AWAIT_WRITE_FINISH_MS;
    const chokidarFactory = options.chokidarFactory ?? chokidar.watch;

    const context = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context);

    const entriesRef = yield* SynchronizedRef.make(new Map<string, ProjectWatcherEntry>());

    const dispatchBatch = (
      entry: ProjectWatcherEntry,
      batch: ReadonlyArray<VaultFileEvent>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const handlers = Array.from(entry.listeners);
        for (const event of batch) {
          for (const handler of handlers) {
            yield* handler(event).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("vault watcher subscriber threw while handling event", {
                      projectId: entry.projectId,
                      kind: event.kind,
                      relativePath: event.relativePath,
                      cause: Cause.pretty(cause),
                    }),
              ),
            );
          }
        }
      });

    const flushPending = (entry: ProjectWatcherEntry): ReadonlyArray<VaultFileEvent> => {
      if (entry.flushTimer !== null) {
        NodeTimers.clearTimeout(entry.flushTimer);
        entry.flushTimer = null;
      }
      if (entry.pending.size === 0) return [];
      const batch = Array.from(entry.pending.values());
      entry.pending = new Map();
      return batch;
    };

    const scheduleFlush = (entry: ProjectWatcherEntry): void => {
      if (entry.flushTimer !== null) return;
      entry.flushTimer = NodeTimers.setTimeout(() => {
        entry.flushTimer = null;
        const batch = flushPending(entry);
        if (batch.length === 0) return;
        runFork(entry.worker.enqueue(batch));
      }, debounceMs);
    };

    const recordEvent = (entry: ProjectWatcherEntry, event: VaultFileEvent): void => {
      entry.pending.set(`${event.kind}:${event.relativePath}`, event);
      scheduleFlush(entry);
    };

    const buildEntry = (
      projectId: ProjectId,
      vaultRoot: string,
    ): Effect.Effect<ProjectWatcherEntry, VaultWatcherError> =>
      Effect.gen(function* () {
        const entryScope = yield* Scope.make("sequential");

        const entryRef: { current: ProjectWatcherEntry | null } = { current: null };

        const worker = yield* makeDrainableWorker<ReadonlyArray<VaultFileEvent>, never, never>(
          (batch) => (entryRef.current ? dispatchBatch(entryRef.current, batch) : Effect.void),
        ).pipe(Scope.provide(entryScope));

        const watcherResult = yield* Effect.try({
          try: () =>
            chokidarFactory(vaultRoot, {
              ignored: [...ignoredVaultWatchPatterns],
              ignoreInitial: true,
              awaitWriteFinish: { stabilityThreshold: awaitWriteFinishMs, pollInterval: 50 },
              persistent: true,
              ignorePermissionErrors: true,
            }),
          catch: (cause) =>
            new VaultWatcherError({
              code: "WATCH_FAILED",
              message: `Failed to start vault watcher for project ${projectId}`,
              cause,
            }),
        }).pipe(
          Effect.tapError(() => Scope.close(entryScope, Exit.void).pipe(Effect.ignoreCause())),
        );

        const entry: ProjectWatcherEntry = {
          projectId,
          vaultRoot,
          watcher: watcherResult,
          listeners: new Set(),
          worker,
          entryScope,
          pending: new Map(),
          flushTimer: null,
        };
        entryRef.current = entry;

        watcherResult.on("all", (eventName, absolutePath) => {
          const kind = eventKindFor(eventName);
          if (kind === null) return;
          if (typeof absolutePath !== "string") return;
          const relativePath = toPosixRelative(vaultRoot, absolutePath);
          if (relativePath.length === 0) return;
          if (!relativePath.toLowerCase().endsWith(NOTE_FILE_EXTENSION)) return;
          recordEvent(entry, {
            projectId,
            kind,
            relativePath,
          });
        });

        watcherResult.on("error", (error) => {
          runFork(
            Effect.logWarning("vault watcher emitted error", {
              projectId,
              vaultRoot,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        });

        return entry;
      });

    const tearDown = (entry: ProjectWatcherEntry): Effect.Effect<void> =>
      Effect.gen(function* () {
        const finalBatch = flushPending(entry);
        if (finalBatch.length > 0) {
          yield* entry.worker.enqueue(finalBatch);
        }
        yield* entry.worker.drain;
        yield* Effect.promise(() => entry.watcher.close()).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("vault watcher failed to close cleanly", {
                  projectId: entry.projectId,
                  cause: Cause.pretty(cause),
                }),
          ),
        );
        yield* Scope.close(entry.entryScope, Exit.void);
      });

    const loadVaultRoot = (projectId: ProjectId): Effect.Effect<string, VaultWatcherError> =>
      projects.getById({ projectId }).pipe(
        Effect.mapError(
          (cause) =>
            new VaultWatcherError({
              code: "PROJECT_NOT_FOUND",
              message: `Failed to load project ${projectId}`,
              cause,
            }),
        ),
        Effect.flatMap((projectOption) =>
          Option.match(projectOption, {
            onNone: () =>
              Effect.fail(
                new VaultWatcherError({
                  code: "PROJECT_NOT_FOUND",
                  message: `Project ${projectId} was not found`,
                }),
              ),
            onSome: (project) => {
              if (project.kind !== "vault") {
                return Effect.fail(
                  new VaultWatcherError({
                    code: "KIND_MISMATCH",
                    message: `Project ${projectId} is not a vault (kind=${project.kind ?? "unknown"})`,
                  }),
                );
              }
              return Effect.succeed(project.workspaceRoot);
            },
          }),
        ),
      );

    const resolveVaultRoot = (
      projectId: ProjectId,
      vaultRoot: string,
    ): Effect.Effect<string, VaultWatcherError> =>
      fileSystem.realPath(path.resolve(vaultRoot)).pipe(
        Effect.mapError(
          (cause) =>
            new VaultWatcherError({
              code: "WATCH_FAILED",
              message: `Failed to resolve vault root for project ${projectId}`,
              cause,
            }),
        ),
      );

    const ensureEntry = (
      projectId: ProjectId,
      vaultRoot: string,
    ): Effect.Effect<ProjectWatcherEntry, VaultWatcherError> =>
      SynchronizedRef.modifyEffect(entriesRef, (entries) => {
        const existing = entries.get(projectId);
        if (existing) {
          if (existing.vaultRoot !== vaultRoot) {
            return Effect.fail(
              new VaultWatcherError({
                code: "WATCH_FAILED",
                message: `Vault watcher for project ${projectId} is already running with a different root`,
              }),
            );
          }
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

    const removeEntry = (projectId: ProjectId): Effect.Effect<Option.Option<ProjectWatcherEntry>> =>
      SynchronizedRef.modify(entriesRef, (entries) => {
        const existing = entries.get(projectId);
        if (!existing) return [Option.none<ProjectWatcherEntry>(), entries] as const;
        const next = new Map(entries);
        next.delete(projectId);
        return [Option.some(existing), next] as const;
      });

    const start: VaultWatcherShape["start"] = (projectId, vaultRoot) =>
      Effect.gen(function* () {
        const resolvedRoot = yield* resolveVaultRoot(projectId, vaultRoot);
        yield* ensureEntry(projectId, resolvedRoot);
      });

    const stop: VaultWatcherShape["stop"] = (projectId) =>
      Effect.gen(function* () {
        const removed = yield* removeEntry(projectId);
        if (Option.isSome(removed)) {
          yield* tearDown(removed.value);
        }
      });

    const detachListener = (projectId: ProjectId, handler: VaultFileEventHandler) =>
      SynchronizedRef.modifyEffect(entriesRef, (entries) => {
        const current = entries.get(projectId);
        if (!current) {
          return Effect.succeed([null as ProjectWatcherEntry | null, entries] as const);
        }
        current.listeners.delete(handler);
        if (current.listeners.size > 0) {
          return Effect.succeed([null as ProjectWatcherEntry | null, entries] as const);
        }
        const next = new Map(entries);
        next.delete(projectId);
        return Effect.succeed([current, next] as const);
      }).pipe(Effect.flatMap((removed) => (removed === null ? Effect.void : tearDown(removed))));

    const subscribe: VaultWatcherShape["subscribe"] = (projectId, handler) =>
      Effect.gen(function* () {
        const projectVaultRoot = yield* loadVaultRoot(projectId);
        const resolvedRoot = yield* resolveVaultRoot(projectId, projectVaultRoot);
        const entry = yield* ensureEntry(projectId, resolvedRoot);
        entry.listeners.add(handler);

        return (): void => {
          runFork(detachListener(projectId, handler));
        };
      });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const entries = yield* SynchronizedRef.getAndUpdate(entriesRef, () => new Map());
        for (const entry of entries.values()) {
          yield* tearDown(entry);
        }
      }),
    );

    return { start, stop, subscribe } satisfies VaultWatcherShape;
  });

export const makeVaultWatcher = makeVaultWatcherWithOptions();

export const VaultWatcherLive = Layer.effect(VaultWatcher, makeVaultWatcher);
