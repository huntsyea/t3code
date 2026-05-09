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
import { VaultIndex, type VaultIndexShape } from "../../src/vault/VaultIndex.ts";
import { VaultRename, VaultRenameLive } from "../../src/vault/VaultRename.ts";

const TEST_PROJECT_ID = ProjectId.make("vault-rename-test");
const NOW_ISO = DateTime.formatIso(DateTime.makeUnsafe("2026-05-09T00:00:00.000Z"));

interface VaultFixture {
  readonly parent: string;
  readonly vaultRoot: string;
}

async function makeVaultFixture(): Promise<VaultFixture> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "vault-rename-"));
  const vaultRoot = path.join(parent, "vault");
  await fs.mkdir(vaultRoot, { recursive: true });
  return { parent, vaultRoot };
}

function makeProjectionProject(input: {
  readonly kind: "vault";
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

function vaultIndexLayerWithBacklinks(backlinksByBasename: Record<string, ReadonlyArray<string>>) {
  const overrides: Partial<VaultIndexShape> = {
    getBacklinks: (_vaultId, basename) => Effect.succeed(backlinksByBasename[basename] ?? []),
  };
  return Layer.mock(VaultIndex)(overrides);
}

function makeTestLayer(input: {
  readonly project: Option.Option<ProjectionProject>;
  readonly backlinks?: Record<string, ReadonlyArray<string>>;
}): Layer.Layer<VaultRename> {
  return VaultRenameLive.pipe(
    Layer.provide(projectionRepoLayer(input.project)),
    Layer.provide(vaultIndexLayerWithBacklinks(input.backlinks ?? {})),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("VaultRename.renameNote", () => {
  it("renames a note and rewrites wikilink references in all backlinking files", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();
    try {
      await fs.writeFile(path.join(vaultRoot, "old-name.md"), "# Old\n\nbody");
      await fs.writeFile(path.join(vaultRoot, "source-a.md"), "Refers to [[old-name]] here.");
      await fs.writeFile(
        path.join(vaultRoot, "source-b.md"),
        "Twice: [[old-name]] and again [[old-name]].\n",
      );
      await fs.writeFile(path.join(vaultRoot, "untouched.md"), "No links here.");

      const layer = makeTestLayer({
        project: Option.some(makeProjectionProject({ kind: "vault", workspaceRoot: vaultRoot })),
        backlinks: {
          "old-name": ["source-a.md", "source-b.md"],
        },
      });

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const rename = yield* VaultRename;
          return yield* rename.renameNote({
            projectId: TEST_PROJECT_ID,
            oldRelativePath: "old-name.md",
            newRelativePath: "new-name.md",
          });
        }).pipe(Effect.provide(layer)),
      );

      expect(result.rewrittenSources).toBe(2);

      await expect(fs.access(path.join(vaultRoot, "old-name.md"))).rejects.toThrow();
      const renamedBody = await fs.readFile(path.join(vaultRoot, "new-name.md"), "utf8");
      expect(renamedBody).toBe("# Old\n\nbody");

      const sourceA = await fs.readFile(path.join(vaultRoot, "source-a.md"), "utf8");
      expect(sourceA).toBe("Refers to [[new-name]] here.");

      const sourceB = await fs.readFile(path.join(vaultRoot, "source-b.md"), "utf8");
      expect(sourceB).toBe("Twice: [[new-name]] and again [[new-name]].\n");
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("does not rewrite wikilinks inside fenced code blocks", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();
    try {
      await fs.writeFile(path.join(vaultRoot, "old.md"), "x");
      const sourceContent = [
        "Real link: [[old]]",
        "",
        "```",
        "code: [[old]] should not change",
        "```",
        "",
        "Trailing real: [[old]]",
        "",
      ].join("\n");
      await fs.writeFile(path.join(vaultRoot, "src.md"), sourceContent);

      const layer = makeTestLayer({
        project: Option.some(makeProjectionProject({ kind: "vault", workspaceRoot: vaultRoot })),
        backlinks: { old: ["src.md"] },
      });

      await Effect.runPromise(
        Effect.gen(function* () {
          const rename = yield* VaultRename;
          return yield* rename.renameNote({
            projectId: TEST_PROJECT_ID,
            oldRelativePath: "old.md",
            newRelativePath: "renamed.md",
          });
        }).pipe(Effect.provide(layer)),
      );

      const result = await fs.readFile(path.join(vaultRoot, "src.md"), "utf8");
      expect(result).toContain("Real link: [[renamed]]");
      expect(result).toContain("code: [[old]] should not change");
      expect(result).toContain("Trailing real: [[renamed]]");
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects path traversal escapes via '..'", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();
    try {
      await fs.writeFile(path.join(vaultRoot, "note.md"), "x");

      const layer = makeTestLayer({
        project: Option.some(makeProjectionProject({ kind: "vault", workspaceRoot: vaultRoot })),
      });

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const rename = yield* VaultRename;
          return yield* rename.renameNote({
            projectId: TEST_PROJECT_ID,
            oldRelativePath: "note.md",
            newRelativePath: "../escape.md",
          });
        }).pipe(Effect.provide(layer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const cause = JSON.stringify(exit.cause);
        expect(cause).toContain("PATH_ESCAPE");
      }

      await expect(fs.access(path.join(vaultRoot, "note.md"))).resolves.toBeUndefined();
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects when the destination already exists", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();
    try {
      await fs.writeFile(path.join(vaultRoot, "a.md"), "a");
      await fs.writeFile(path.join(vaultRoot, "b.md"), "b");

      const layer = makeTestLayer({
        project: Option.some(makeProjectionProject({ kind: "vault", workspaceRoot: vaultRoot })),
      });

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const rename = yield* VaultRename;
          return yield* rename.renameNote({
            projectId: TEST_PROJECT_ID,
            oldRelativePath: "a.md",
            newRelativePath: "b.md",
          });
        }).pipe(Effect.provide(layer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("ALREADY_EXISTS");
      }

      const aStill = await fs.readFile(path.join(vaultRoot, "a.md"), "utf8");
      expect(aStill).toBe("a");
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects when the source note does not exist", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();
    try {
      const layer = makeTestLayer({
        project: Option.some(makeProjectionProject({ kind: "vault", workspaceRoot: vaultRoot })),
      });

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const rename = yield* VaultRename;
          return yield* rename.renameNote({
            projectId: TEST_PROJECT_ID,
            oldRelativePath: "missing.md",
            newRelativePath: "renamed.md",
          });
        }).pipe(Effect.provide(layer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("NOT_FOUND");
      }
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("renames within a subdirectory and creates parent dirs in the destination", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();
    try {
      await fs.mkdir(path.join(vaultRoot, "notes"));
      await fs.writeFile(path.join(vaultRoot, "notes", "alpha.md"), "alpha body");
      await fs.writeFile(path.join(vaultRoot, "ref.md"), "See [[alpha]] for details.");

      const layer = makeTestLayer({
        project: Option.some(makeProjectionProject({ kind: "vault", workspaceRoot: vaultRoot })),
        backlinks: { alpha: ["ref.md"] },
      });

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const rename = yield* VaultRename;
          return yield* rename.renameNote({
            projectId: TEST_PROJECT_ID,
            oldRelativePath: "notes/alpha.md",
            newRelativePath: "moved/beta.md",
          });
        }).pipe(Effect.provide(layer)),
      );

      expect(result.rewrittenSources).toBe(1);
      const moved = await fs.readFile(path.join(vaultRoot, "moved", "beta.md"), "utf8");
      expect(moved).toBe("alpha body");
      const ref = await fs.readFile(path.join(vaultRoot, "ref.md"), "utf8");
      expect(ref).toBe("See [[beta]] for details.");
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("returns rewrittenSources=0 when basename is unchanged (e.g., directory move only)", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();
    try {
      await fs.mkdir(path.join(vaultRoot, "src-dir"));
      await fs.writeFile(path.join(vaultRoot, "src-dir", "same.md"), "body");

      const layer = makeTestLayer({
        project: Option.some(makeProjectionProject({ kind: "vault", workspaceRoot: vaultRoot })),
      });

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const rename = yield* VaultRename;
          return yield* rename.renameNote({
            projectId: TEST_PROJECT_ID,
            oldRelativePath: "src-dir/same.md",
            newRelativePath: "dest-dir/same.md",
          });
        }).pipe(Effect.provide(layer)),
      );

      expect(result.rewrittenSources).toBe(0);
      const moved = await fs.readFile(path.join(vaultRoot, "dest-dir", "same.md"), "utf8");
      expect(moved).toBe("body");
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});
