import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import { ProjectId } from "@t3tools/contracts";

import { ProjectionProjectRepository } from "../../src/persistence/Services/ProjectionProjects.ts";
import type { ProjectionProject } from "../../src/persistence/Services/ProjectionProjects.ts";
import { VaultReader, VaultReaderLive, makeVaultReader } from "../../src/vault/VaultReader.ts";
import { VcsDriverRegistry } from "../../src/vcs/VcsDriverRegistry.ts";
import type { VcsDriverHandle } from "../../src/vcs/VcsDriverRegistry.ts";
import type { VcsDriverShape } from "../../src/vcs/VcsDriver.ts";

void makeVaultReader;
void VaultReaderLive;

const TEST_PROJECT_ID = ProjectId.make("test-vault");
const NOW_ISO = DateTime.formatIso(DateTime.makeUnsafe("2026-05-09T00:00:00.000Z"));

interface VaultFixture {
  readonly parent: string;
  readonly vaultRoot: string;
}

async function makeVaultFixture(): Promise<VaultFixture> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "vault-reader-"));
  const vaultRoot = path.join(parent, "vault");
  await fs.mkdir(vaultRoot, { recursive: true });
  return { parent, vaultRoot };
}

function makeProjectionProject(input: {
  readonly kind: "vault" | "code";
  readonly workspaceRoot: string;
}): ProjectionProject {
  return {
    projectId: TEST_PROJECT_ID,
    kind: input.kind,
    title: "Test vault",
    workspaceRoot: input.workspaceRoot,
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

function vcsRegistryLayer(handle: VcsDriverHandle | null) {
  return Layer.mock(VcsDriverRegistry)({
    detect: () => Effect.succeed(handle),
  });
}

function vcsHandleWithIgnore(ignored: ReadonlyArray<string>): VcsDriverHandle {
  const driver: Partial<VcsDriverShape> = {
    filterIgnoredPaths: (_cwd, paths) =>
      Effect.succeed(paths.filter((entry) => !ignored.includes(entry))),
  };
  return {
    kind: "git",
    repository: {} as unknown as VcsDriverHandle["repository"],
    driver: driver as VcsDriverShape,
  };
}

function makeTestLayer(input: {
  readonly project: Option.Option<ProjectionProject>;
  readonly vcs?: VcsDriverHandle | null;
}): Layer.Layer<VaultReader> {
  const vcsHandle = input.vcs ?? null;
  return VaultReaderLive.pipe(
    Layer.provide(projectionRepoLayer(input.project)),
    Layer.provide(vcsRegistryLayer(vcsHandle)),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("VaultReader.readNote", () => {
  it("reads a markdown note from a vault project", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();
    try {
      await fs.mkdir(path.join(vaultRoot, "notes"), { recursive: true });
      await fs.writeFile(path.join(vaultRoot, "notes", "today.md"), "# Today\n\nHello.");

      const layer = makeTestLayer({
        project: Option.some(makeProjectionProject({ kind: "vault", workspaceRoot: vaultRoot })),
      });

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const reader = yield* VaultReader;
          return yield* reader.readNote({
            projectId: TEST_PROJECT_ID,
            relativePath: "notes/today.md",
          });
        }).pipe(Effect.provide(layer)),
      );

      expect(result.content).toBe("# Today\n\nHello.");
      expect(result.size).toBe(Buffer.byteLength("# Today\n\nHello.", "utf8"));
      expect(typeof result.mtime).toBe("string");
      expect(result.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects when project kind is not 'vault'", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();
    try {
      await fs.writeFile(path.join(vaultRoot, "note.md"), "blocked");

      const layer = makeTestLayer({
        project: Option.some(makeProjectionProject({ kind: "code", workspaceRoot: vaultRoot })),
      });

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const reader = yield* VaultReader;
          return yield* reader.readNote({
            projectId: TEST_PROJECT_ID,
            relativePath: "note.md",
          });
        }).pipe(Effect.provide(layer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const cause = exit.cause;
        const error = JSON.stringify(cause);
        expect(error).toContain("KIND_MISMATCH");
      }
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects when project is not found", async () => {
    const layer = makeTestLayer({ project: Option.none() });

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const reader = yield* VaultReader;
        return yield* reader.readNote({
          projectId: TEST_PROJECT_ID,
          relativePath: "anything.md",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = JSON.stringify(exit.cause);
      expect(error).toContain("PROJECT_NOT_FOUND");
    }
  });

  it("rejects path traversal escapes via '..'", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();
    try {
      const outsideDir = path.join(parent, "outside");
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(outsideDir, "escape.md"), "secret");

      const layer = makeTestLayer({
        project: Option.some(makeProjectionProject({ kind: "vault", workspaceRoot: vaultRoot })),
      });

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const reader = yield* VaultReader;
          return yield* reader.readNote({
            projectId: TEST_PROJECT_ID,
            relativePath: "../outside/escape.md",
          });
        }).pipe(Effect.provide(layer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = JSON.stringify(exit.cause);
        expect(error).toContain("PATH_ESCAPE");
      }
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects symlink-based escapes", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();
    try {
      const outsideDir = path.join(parent, "outside");
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(outsideDir, "escape.md"), "secret");
      await fs.symlink(path.join(outsideDir, "escape.md"), path.join(vaultRoot, "linked.md"));

      const layer = makeTestLayer({
        project: Option.some(makeProjectionProject({ kind: "vault", workspaceRoot: vaultRoot })),
      });

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const reader = yield* VaultReader;
          return yield* reader.readNote({
            projectId: TEST_PROJECT_ID,
            relativePath: "linked.md",
          });
        }).pipe(Effect.provide(layer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = JSON.stringify(exit.cause);
        expect(error).toContain("PATH_ESCAPE");
      }
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("returns NOT_FOUND for missing files inside the vault", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();
    try {
      const layer = makeTestLayer({
        project: Option.some(makeProjectionProject({ kind: "vault", workspaceRoot: vaultRoot })),
      });

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const reader = yield* VaultReader;
          return yield* reader.readNote({
            projectId: TEST_PROJECT_ID,
            relativePath: "missing.md",
          });
        }).pipe(Effect.provide(layer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = JSON.stringify(exit.cause);
        expect(error).toContain("NOT_FOUND");
      }
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});

describe("VaultReader.listEntries", () => {
  it("lists vault entries: directories first, then markdown files only, sorted alphabetically", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();
    try {
      await fs.writeFile(path.join(vaultRoot, "z-late.md"), "z");
      await fs.writeFile(path.join(vaultRoot, "alpha.md"), "a");
      await fs.writeFile(path.join(vaultRoot, "ignore.txt"), "skip");
      await fs.writeFile(path.join(vaultRoot, ".hidden.md"), "hidden");
      await fs.mkdir(path.join(vaultRoot, "zeta"));
      await fs.mkdir(path.join(vaultRoot, "alpha-dir"));
      await fs.mkdir(path.join(vaultRoot, ".git"));

      const layer = makeTestLayer({
        project: Option.some(makeProjectionProject({ kind: "vault", workspaceRoot: vaultRoot })),
      });

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const reader = yield* VaultReader;
          return yield* reader.listEntries({
            projectId: TEST_PROJECT_ID,
            relativeDir: "",
          });
        }).pipe(Effect.provide(layer)),
      );

      const names = result.entries.map((entry) => `${entry.kind}:${entry.name}`);
      expect(names).toEqual(["dir:alpha-dir", "dir:zeta", "file:alpha.md", "file:z-late.md"]);

      for (const entry of result.entries) {
        expect(entry.relativePath.startsWith(".")).toBe(false);
      }
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("filters entries via .gitignore when VCS is detected", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();
    try {
      await fs.writeFile(path.join(vaultRoot, "kept.md"), "keep");
      await fs.writeFile(path.join(vaultRoot, "secret.md"), "ignored");
      await fs.mkdir(path.join(vaultRoot, "drafts"));

      const layer = makeTestLayer({
        project: Option.some(makeProjectionProject({ kind: "vault", workspaceRoot: vaultRoot })),
        vcs: vcsHandleWithIgnore(["secret.md", "drafts"]),
      });

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const reader = yield* VaultReader;
          return yield* reader.listEntries({
            projectId: TEST_PROJECT_ID,
            relativeDir: "",
          });
        }).pipe(Effect.provide(layer)),
      );

      const names = result.entries.map((entry) => entry.name);
      expect(names).toEqual(["kept.md"]);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("does not recurse into subdirectories", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();
    try {
      await fs.writeFile(path.join(vaultRoot, "top.md"), "top");
      await fs.mkdir(path.join(vaultRoot, "sub"));
      await fs.writeFile(path.join(vaultRoot, "sub", "child.md"), "child");

      const layer = makeTestLayer({
        project: Option.some(makeProjectionProject({ kind: "vault", workspaceRoot: vaultRoot })),
      });

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const reader = yield* VaultReader;
          return yield* reader.listEntries({
            projectId: TEST_PROJECT_ID,
            relativeDir: "",
          });
        }).pipe(Effect.provide(layer)),
      );

      const names = result.entries.map((entry) => entry.name);
      expect(names).toEqual(["sub", "top.md"]);
      expect(names).not.toContain("child.md");
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects directory listing when project kind is not 'vault'", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();
    try {
      const layer = makeTestLayer({
        project: Option.some(makeProjectionProject({ kind: "code", workspaceRoot: vaultRoot })),
      });

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const reader = yield* VaultReader;
          return yield* reader.listEntries({
            projectId: TEST_PROJECT_ID,
            relativeDir: "",
          });
        }).pipe(Effect.provide(layer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = JSON.stringify(exit.cause);
        expect(error).toContain("KIND_MISMATCH");
      }
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects path escapes via '..'", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();
    try {
      const outsideDir = path.join(parent, "outside");
      await fs.mkdir(outsideDir, { recursive: true });

      const layer = makeTestLayer({
        project: Option.some(makeProjectionProject({ kind: "vault", workspaceRoot: vaultRoot })),
      });

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const reader = yield* VaultReader;
          return yield* reader.listEntries({
            projectId: TEST_PROJECT_ID,
            relativeDir: "../outside",
          });
        }).pipe(Effect.provide(layer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = JSON.stringify(exit.cause);
        expect(error).toContain("PATH_ESCAPE");
      }
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});
