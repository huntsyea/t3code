/**
 * Per-thread tab state persistence with debounced (default 250ms) DB writes
 * and post-write subscriber notifications. Mirrors the terminal-manager
 * subscribe pattern; intentionally NOT a domain event.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeTimers from "node:timers";

import {
  type ProjectId,
  type Tab,
  TabId,
  type TabStateChange,
  type ThreadId,
  ThreadTabState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class ThreadTabPersistenceError extends Schema.TaggedErrorClass<ThreadTabPersistenceError>()(
  "ThreadTabPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Thread tab persistence error in ${this.operation}: ${this.detail}`;
  }
}

const DEFAULT_DEBOUNCE_MS = 250;

type ListenerFn = (change: TabStateChange) => Effect.Effect<void>;

export interface ThreadTabPersistenceShape {
  readonly getState: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadTabState, ThreadTabPersistenceError>;
  readonly saveState: (
    threadId: ThreadId,
    state: ThreadTabState,
  ) => Effect.Effect<void, ThreadTabPersistenceError>;
  readonly openNoteTab: (input: {
    readonly threadId: ThreadId;
    readonly vaultId: ProjectId;
    readonly relativePath: string;
  }) => Effect.Effect<Tab, ThreadTabPersistenceError>;
  readonly closeTab: (input: {
    readonly threadId: ThreadId;
    readonly tabId: TabId;
  }) => Effect.Effect<void, ThreadTabPersistenceError>;
  readonly activateTab: (input: {
    readonly threadId: ThreadId;
    readonly tabId: TabId;
  }) => Effect.Effect<void, ThreadTabPersistenceError>;
  readonly reorderTabs: (input: {
    readonly threadId: ThreadId;
    readonly orderedIds: ReadonlyArray<string>;
  }) => Effect.Effect<void, ThreadTabPersistenceError>;
  readonly subscribe: (threadId: ThreadId, handler: ListenerFn) => Effect.Effect<() => void>;
  readonly flushAll: () => Effect.Effect<void, ThreadTabPersistenceError>;
}

export class ThreadTabPersistence extends Context.Service<
  ThreadTabPersistence,
  ThreadTabPersistenceShape
>()("t3/vault/ThreadTabPersistence") {}

export interface ThreadTabPersistenceOptions {
  readonly debounceMs?: number;
}

export const defaultThreadTabState = (threadId: ThreadId): ThreadTabState => ({
  threadId,
  tabs: [
    {
      kind: "chat",
      id: threadId,
      title: "Chat",
    },
  ],
  activeTabId: threadId,
});

const StoredThreadTabState = Schema.fromJsonString(ThreadTabState);
const encodeStateJson = Schema.encodeSync(StoredThreadTabState);
const decodeStateJson = Schema.decodeEffect(StoredThreadTabState);

export const makeThreadTabPersistence = (options: ThreadTabPersistenceOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const context = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context);

    const pendingStates = new Map<ThreadId, ThreadTabState>();
    const debounceTimers = new Map<ThreadId, ReturnType<typeof NodeTimers.setTimeout>>();
    const listeners = new Map<ThreadId, Set<ListenerFn>>();

    const persistState = (threadId: ThreadId, state: ThreadTabState) =>
      Effect.gen(function* () {
        const stateJson = encodeStateJson(state);
        const updatedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

        yield* sql`
          INSERT INTO thread_tab_state (thread_id, state_json, updated_at)
          VALUES (${threadId}, ${stateJson}, ${updatedAt})
          ON CONFLICT (thread_id) DO UPDATE SET
            state_json = excluded.state_json,
            updated_at = excluded.updated_at
        `.pipe(
          Effect.mapError(
            (cause) =>
              new ThreadTabPersistenceError({
                operation: "ThreadTabPersistence.persistState",
                detail: "Failed to persist tab state",
                cause,
              }),
          ),
        );
      });

    const notifySubscribers = (threadId: ThreadId, state: ThreadTabState) =>
      Effect.gen(function* () {
        const handlers = listeners.get(threadId);
        if (!handlers || handlers.size === 0) return;
        const change: TabStateChange = { threadId, state };
        yield* Effect.forEach(
          Array.from(handlers),
          (handler) => handler(change).pipe(Effect.ignoreCause({ log: true })),
          { concurrency: "unbounded", discard: true },
        );
      });

    const flushThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const state = pendingStates.get(threadId);
        if (!state) return;
        pendingStates.delete(threadId);
        const timer = debounceTimers.get(threadId);
        if (timer) {
          NodeTimers.clearTimeout(timer);
          debounceTimers.delete(threadId);
        }
        yield* persistState(threadId, state);
        yield* notifySubscribers(threadId, state);
      });

    const scheduleDebouncedFlush = (threadId: ThreadId) =>
      Effect.sync(() => {
        const existing = debounceTimers.get(threadId);
        if (existing) {
          NodeTimers.clearTimeout(existing);
        }
        if (debounceMs <= 0) {
          debounceTimers.delete(threadId);
          runFork(flushThread(threadId).pipe(Effect.ignoreCause({ log: true })));
          return;
        }
        // @effect-diagnostics-next-line globalTimers:off - debounce uses JS event loop intentionally to coalesce rapid saves without holding an Effect fiber.
        const timer = NodeTimers.setTimeout(() => {
          debounceTimers.delete(threadId);
          runFork(flushThread(threadId).pipe(Effect.ignoreCause({ log: true })));
        }, debounceMs);
        debounceTimers.set(threadId, timer);
      });

    const getState: ThreadTabPersistenceShape["getState"] = (threadId) =>
      Effect.gen(function* () {
        const pending = pendingStates.get(threadId);
        if (pending) return pending;

        const rows = yield* sql<{ readonly state_json: string }>`
          SELECT state_json FROM thread_tab_state WHERE thread_id = ${threadId}
        `.pipe(
          Effect.mapError(
            (cause) =>
              new ThreadTabPersistenceError({
                operation: "ThreadTabPersistence.getState",
                detail: "Failed to query tab state",
                cause,
              }),
          ),
        );

        const row = rows[0];
        if (!row) {
          return defaultThreadTabState(threadId);
        }

        return yield* decodeStateJson(row.state_json).pipe(
          Effect.mapError(
            (cause) =>
              new ThreadTabPersistenceError({
                operation: "ThreadTabPersistence.getState",
                detail: "Failed to decode tab state",
                cause,
              }),
          ),
        );
      });

    const saveState: ThreadTabPersistenceShape["saveState"] = (threadId, state) =>
      Effect.gen(function* () {
        pendingStates.set(threadId, state);
        yield* scheduleDebouncedFlush(threadId);
      });

    const openNoteTab: ThreadTabPersistenceShape["openNoteTab"] = (input) =>
      Effect.gen(function* () {
        const current = yield* getState(input.threadId);
        const existing = current.tabs.find(
          (tab): tab is Extract<Tab, { kind: "note" }> =>
            tab.kind === "note" &&
            tab.vaultId === input.vaultId &&
            tab.relativePath === input.relativePath,
        );

        if (existing) {
          if (current.activeTabId !== existing.id) {
            yield* saveState(input.threadId, {
              ...current,
              activeTabId: existing.id,
            });
          }
          return existing;
        }

        const tabId = TabId.make(crypto.randomUUID());
        const newTab: Tab = {
          kind: "note",
          id: tabId,
          vaultId: input.vaultId,
          relativePath: input.relativePath,
          scrollPos: 0,
          isDirty: false,
        };

        yield* saveState(input.threadId, {
          ...current,
          tabs: [...current.tabs, newTab],
          activeTabId: tabId,
        });

        return newTab;
      });

    const closeTab: ThreadTabPersistenceShape["closeTab"] = (input) =>
      Effect.gen(function* () {
        const current = yield* getState(input.threadId);
        const filtered = current.tabs.filter((tab) => tab.id !== input.tabId);
        if (filtered.length === current.tabs.length) {
          return;
        }
        let nextActiveTabId: string = current.activeTabId;
        if (current.activeTabId === input.tabId) {
          const fallback = filtered[0];
          nextActiveTabId = fallback ? fallback.id : input.threadId;
        }
        yield* saveState(input.threadId, {
          ...current,
          tabs: filtered,
          activeTabId: nextActiveTabId,
        });
      });

    const activateTab: ThreadTabPersistenceShape["activateTab"] = (input) =>
      Effect.gen(function* () {
        const current = yield* getState(input.threadId);
        if (current.activeTabId === input.tabId) return;
        if (!current.tabs.some((tab) => tab.id === input.tabId)) return;
        yield* saveState(input.threadId, {
          ...current,
          activeTabId: input.tabId,
        });
      });

    const reorderTabs: ThreadTabPersistenceShape["reorderTabs"] = (input) =>
      Effect.gen(function* () {
        const current = yield* getState(input.threadId);
        const tabsById = new Map<string, Tab>(current.tabs.map((tab) => [tab.id as string, tab]));
        const reordered: Array<Tab> = [];
        for (const id of input.orderedIds) {
          const tab = tabsById.get(id);
          if (tab) {
            reordered.push(tab);
            tabsById.delete(id);
          }
        }
        for (const tab of tabsById.values()) {
          reordered.push(tab);
        }
        yield* saveState(input.threadId, {
          ...current,
          tabs: reordered,
        });
      });

    const subscribe: ThreadTabPersistenceShape["subscribe"] = (threadId, handler) =>
      Effect.sync(() => {
        let set = listeners.get(threadId);
        if (!set) {
          set = new Set<ListenerFn>();
          listeners.set(threadId, set);
        }
        set.add(handler);
        return () => {
          const current = listeners.get(threadId);
          if (!current) return;
          current.delete(handler);
          if (current.size === 0) {
            listeners.delete(threadId);
          }
        };
      });

    const flushAll: ThreadTabPersistenceShape["flushAll"] = () =>
      Effect.gen(function* () {
        const ids = Array.from(pendingStates.keys());
        yield* Effect.forEach(ids, (id) => flushThread(id), {
          concurrency: "unbounded",
          discard: true,
        });
      });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        for (const timer of debounceTimers.values()) {
          NodeTimers.clearTimeout(timer);
        }
        debounceTimers.clear();
        yield* flushAll().pipe(Effect.ignoreCause({ log: true }));
      }),
    );

    return {
      getState,
      saveState,
      openNoteTab,
      closeTab,
      activateTab,
      reorderTabs,
      subscribe,
      flushAll,
    } satisfies ThreadTabPersistenceShape;
  });

export const ThreadTabPersistenceLive = Layer.effect(
  ThreadTabPersistence,
  makeThreadTabPersistence(),
);
