import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, type VaultFileEvent } from "@t3tools/contracts";
import * as chokidar from "chokidar";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectionProjectRepository } from "../../src/persistence/Services/ProjectionProjects.ts";
import type { ProjectionProject } from "../../src/persistence/Services/ProjectionProjects.ts";
import {
  type ChokidarFactory,
  makeVaultWatcherWithOptions,
  VaultWatcher,
} from "../../src/vault/VaultWatcher.ts";

const PROJECT_ID = ProjectId.make("vault-watch-project");
const NOW_ISO = DateTime.formatIso(DateTime.makeUnsafe("2026-05-09T00:00:00.000Z"));
const DEBOUNCE_MS = 25;
const FLUSH_WAIT_MS = DEBOUNCE_MS * 4;

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (!directory) break;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function makeVaultDir(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "vault-watcher-"));
  tempDirs.push(parent);
  const root = path.join(parent, "vault");
  await fs.mkdir(root, { recursive: true });
  return await fs.realpath(root);
}

function makeProject(root: string): ProjectionProject {
  return {
    projectId: PROJECT_ID,
    kind: "vault",
    title: "Watcher fixture",
    workspaceRoot: root,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    deletedAt: null,
  };
}

function projectionRepoLayer(project: Option.Option<ProjectionProject>) {
  return Layer.mock(ProjectionProjectRepository)({
    getById: () => Effect.succeed(project),
  });
}

class FakeWatcher extends EventEmitter {
  closed = false;
  closedCount = 0;

  async close(): Promise<void> {
    this.closed = true;
    this.closedCount += 1;
  }

  emitChokidar(event: "add" | "change" | "unlink" | "addDir" | "unlinkDir", absolutePath: string) {
    this.emit(event, absolutePath);
    this.emit("all", event, absolutePath);
  }
}

interface FakeFactoryHandle {
  readonly factory: ChokidarFactory;
  readonly watchers: FakeWatcher[];
  readonly invocations: Array<{ paths: string; options: chokidar.ChokidarOptions }>;
}

function makeFakeChokidar(): FakeFactoryHandle {
  const watchers: FakeWatcher[] = [];
  const invocations: Array<{ paths: string; options: chokidar.ChokidarOptions }> = [];
  const factory: ChokidarFactory = (paths, options) => {
    invocations.push({ paths, options });
    const watcher = new FakeWatcher();
    watchers.push(watcher);
    return watcher as unknown as chokidar.FSWatcher;
  };
  return { factory, watchers, invocations };
}

function buildLayers(
  root: string,
  factoryHandle: FakeFactoryHandle,
  options: { debounceMs?: number; awaitWriteFinishMs?: number } = {},
) {
  const repoLayer = projectionRepoLayer(Option.some(makeProject(root)));
  const watcherLayer = Layer.effect(
    VaultWatcher,
    makeVaultWatcherWithOptions({
      debounceMs: options.debounceMs ?? DEBOUNCE_MS,
      awaitWriteFinishMs: options.awaitWriteFinishMs ?? 5,
      chokidarFactory: factoryHandle.factory,
    }),
  ).pipe(Layer.provide(repoLayer), Layer.provide(NodeServices.layer));
  return watcherLayer;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("VaultWatcher.subscribe", () => {
  it("emits added/changed/removed events for .md files", async () => {
    const root = await makeVaultDir();
    const factory = makeFakeChokidar();
    const layer = buildLayers(root, factory);

    const captured: VaultFileEvent[] = [];

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const watcher = yield* VaultWatcher;
          const unsubscribe = yield* watcher.subscribe(PROJECT_ID, (event) =>
            Effect.sync(() => {
              captured.push(event);
            }),
          );

          expect(factory.watchers.length).toBe(1);
          const fakeWatcher = factory.watchers[0]!;
          fakeWatcher.emitChokidar("add", path.join(root, "alpha.md"));
          fakeWatcher.emitChokidar("change", path.join(root, "alpha.md"));
          fakeWatcher.emitChokidar("unlink", path.join(root, "notes", "old.md"));
          fakeWatcher.emitChokidar("change", path.join(root, "notes", "todo.txt"));

          yield* Effect.promise(() => wait(FLUSH_WAIT_MS));
          yield* Effect.sync(unsubscribe);
          yield* Effect.promise(() => wait(FLUSH_WAIT_MS));
        }),
      ).pipe(Effect.provide(layer)),
    );

    const sorted = [...captured].sort((a, b) =>
      `${a.relativePath}:${a.kind}`.localeCompare(`${b.relativePath}:${b.kind}`),
    );
    expect(sorted).toEqual([
      { projectId: PROJECT_ID, kind: "added", relativePath: "alpha.md" },
      { projectId: PROJECT_ID, kind: "changed", relativePath: "alpha.md" },
      { projectId: PROJECT_ID, kind: "removed", relativePath: "notes/old.md" },
    ]);
    expect(factory.watchers[0]!.closed).toBe(true);
  });

  it("ignores files inside .git/ and .atlas/ via chokidar's ignored option", async () => {
    const root = await makeVaultDir();
    const factory = makeFakeChokidar();
    const layer = buildLayers(root, factory);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const watcher = yield* VaultWatcher;
          yield* watcher.subscribe(PROJECT_ID, (_event) => Effect.void);
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(factory.invocations.length).toBe(1);
    const ignored = factory.invocations[0]!.options.ignored;
    expect(Array.isArray(ignored)).toBe(true);
    const patterns = (ignored as ReadonlyArray<RegExp>).map((entry) => entry.source);
    expect(patterns).toEqual(["\\/\\.git\\/", "\\/\\.atlas\\/"]);
  });

  it("debounces rapid changes into a single batched dispatch per relative path", async () => {
    const root = await makeVaultDir();
    const factory = makeFakeChokidar();
    const layer = buildLayers(root, factory);

    const captured: VaultFileEvent[] = [];

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const watcher = yield* VaultWatcher;
          const unsubscribe = yield* watcher.subscribe(PROJECT_ID, (event) =>
            Effect.sync(() => {
              captured.push(event);
            }),
          );

          const fakeWatcher = factory.watchers[0]!;
          for (let index = 0; index < 25; index += 1) {
            fakeWatcher.emitChokidar("change", path.join(root, "rapid.md"));
          }
          fakeWatcher.emitChokidar("change", path.join(root, "other.md"));

          yield* Effect.promise(() => wait(FLUSH_WAIT_MS));
          yield* Effect.sync(unsubscribe);
        }),
      ).pipe(Effect.provide(layer)),
    );

    const changedPaths = captured.map((event) => event.relativePath).sort();
    expect(changedPaths).toEqual(["other.md", "rapid.md"]);
    expect(captured.every((event) => event.kind === "changed")).toBe(true);
  });

  it("starts a single watcher for multiple subscribers and stops only when the last unsubscribes", async () => {
    const root = await makeVaultDir();
    const factory = makeFakeChokidar();
    const layer = buildLayers(root, factory);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const watcher = yield* VaultWatcher;
          const unsubscribeA = yield* watcher.subscribe(PROJECT_ID, () => Effect.void);
          const unsubscribeB = yield* watcher.subscribe(PROJECT_ID, () => Effect.void);

          expect(factory.watchers.length).toBe(1);

          yield* Effect.sync(unsubscribeA);
          yield* Effect.promise(() => wait(FLUSH_WAIT_MS));
          expect(factory.watchers[0]!.closed).toBe(false);

          yield* Effect.sync(unsubscribeB);
          yield* Effect.promise(() => wait(FLUSH_WAIT_MS));
          expect(factory.watchers[0]!.closed).toBe(true);
        }),
      ).pipe(Effect.provide(layer)),
    );
  });
});
