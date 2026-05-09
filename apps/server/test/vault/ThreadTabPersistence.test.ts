import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ProjectId, type TabStateChange, ThreadId, type ThreadTabState } from "@t3tools/contracts";

import { runMigrations } from "../../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "../../src/persistence/NodeSqliteClient.ts";
import {
  ThreadTabPersistence,
  makeThreadTabPersistence,
} from "../../src/vault/ThreadTabPersistence.ts";

const ThreadTabPersistenceTestLive = Layer.effect(
  ThreadTabPersistence,
  makeThreadTabPersistence({ debounceMs: 0 }),
);

const TestLayer = ThreadTabPersistenceTestLive.pipe(
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
);

const layer = it.layer(TestLayer);

const THREAD_ID = ThreadId.make("thread-tab-state-test");
const PROJECT_ID = ProjectId.make("project-tab-state-test");

layer("ThreadTabPersistence", (it) => {
  it.effect("returns the default chat-only state when no row exists", () =>
    Effect.gen(function* () {
      yield* runMigrations({});
      const persistence = yield* ThreadTabPersistence;

      const state = yield* persistence.getState(THREAD_ID);

      assert.equal(state.threadId, THREAD_ID);
      assert.equal(state.activeTabId, THREAD_ID);
      assert.equal(state.tabs.length, 1);
      const firstTab = state.tabs[0];
      assert.ok(firstTab);
      assert.equal(firstTab.kind, "chat");
      assert.equal(firstTab.id, THREAD_ID);
      if (firstTab.kind === "chat") {
        assert.equal(firstTab.title, "Chat");
      }
    }),
  );

  it.effect("round-trips state through saveState → flushAll → getState", () =>
    Effect.gen(function* () {
      yield* runMigrations({});
      const persistence = yield* ThreadTabPersistence;

      const initial = yield* persistence.getState(THREAD_ID);
      const note = yield* persistence.openNoteTab({
        threadId: THREAD_ID,
        vaultId: PROJECT_ID,
        relativePath: "notes/today.md",
      });

      yield* persistence.flushAll();

      const persisted = yield* persistence.getState(THREAD_ID);

      assert.equal(persisted.threadId, THREAD_ID);
      assert.equal(persisted.tabs.length, initial.tabs.length + 1);
      assert.equal(persisted.activeTabId, note.id);

      const persistedNote = persisted.tabs.find((tab) => tab.id === note.id);
      assert.ok(persistedNote);
      assert.equal(persistedNote.kind, "note");
      if (persistedNote.kind === "note") {
        assert.equal(persistedNote.vaultId, PROJECT_ID);
        assert.equal(persistedNote.relativePath, "notes/today.md");
      }
    }),
  );

  it.effect("subscribers receive a TabStateChange after a save flushes", () =>
    Effect.gen(function* () {
      yield* runMigrations({});
      const persistence = yield* ThreadTabPersistence;
      const context = yield* Effect.context<never>();

      const receivedRef = yield* Ref.make<ReadonlyArray<TabStateChange>>([]);

      const unsubscribe = yield* persistence.subscribe(THREAD_ID, (change) =>
        Ref.update(receivedRef, (current) => [...current, change]).pipe(
          Effect.provide(Context.omit<never>()(context)),
        ),
      );

      const initial = yield* persistence.getState(THREAD_ID);
      const next: ThreadTabState = {
        ...initial,
        activeTabId: initial.activeTabId,
      };

      yield* persistence.saveState(THREAD_ID, next);
      yield* persistence.flushAll();

      const received = yield* Ref.get(receivedRef);
      assert.equal(received.length, 1);
      const change = received[0];
      assert.ok(change);
      assert.equal(change.threadId, THREAD_ID);
      assert.equal(change.state.threadId, THREAD_ID);

      unsubscribe();

      yield* persistence.saveState(THREAD_ID, next);
      yield* persistence.flushAll();

      const afterUnsubscribe = yield* Ref.get(receivedRef);
      assert.equal(afterUnsubscribe.length, 1, "no further notifications after unsubscribe");
    }),
  );
});
