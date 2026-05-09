// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as EffectFileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as EffectPath from "effect/Path";

import {
  type ProjectId,
  VaultGetVersionHistoryInput,
  VaultGetVersionHistoryResult,
  VaultRevertToVersionInput,
  VaultRevertToVersionResult,
  VaultVersionHistoryError,
} from "@t3tools/contracts";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { runProcess } from "../processRunner.ts";
import { safeVaultWrite, SafeVaultWriteError } from "./SafeVaultWrite.ts";

export interface VaultVersionHistoryShape {
  readonly getVersionHistory: (
    input: VaultGetVersionHistoryInput,
  ) => Effect.Effect<VaultGetVersionHistoryResult, VaultVersionHistoryError>;

  readonly revertToVersion: (
    input: VaultRevertToVersionInput,
  ) => Effect.Effect<VaultRevertToVersionResult, VaultVersionHistoryError>;
}

export class VaultVersionHistory extends Context.Service<
  VaultVersionHistory,
  VaultVersionHistoryShape
>()("t3/vault/VaultVersionHistory") {}

const NOTE_FILE_EXTENSION = ".md";
const GIT_LOG_TIMEOUT_MS = 15_000;
const GIT_SHOW_TIMEOUT_MS = 15_000;
const GIT_COMMIT_TIMEOUT_MS = 30_000;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

const isNotFoundError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: string }).code === "ENOENT";

const normalizeRelativePath = (input: string): string | null => {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes("\0")) return null;
  if (path.isAbsolute(trimmed)) return null;
  return trimmed;
};

const isWithinVaultRoot = (vaultRoot: string, resolved: string): boolean => {
  const relative = path.relative(vaultRoot, resolved);
  if (relative.length === 0 || relative === ".") return false;
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) return false;
  if (path.isAbsolute(relative)) return false;
  if (process.platform === "darwin") {
    const rootLower = vaultRoot.toLowerCase();
    const resolvedLower = resolved.toLowerCase();
    return resolvedLower === rootLower || resolvedLower.startsWith(rootLower + path.sep);
  }
  return resolved === vaultRoot || resolved.startsWith(vaultRoot + path.sep);
};

const toPosixPath = (relative: string): string => relative.replaceAll("\\", "/");

const checkGitDirectory = (vaultRoot: string): Effect.Effect<boolean, VaultVersionHistoryError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const stat = await fs.stat(path.join(vaultRoot, ".git"));
        return stat.isDirectory() || stat.isFile();
      } catch (error) {
        if (isNotFoundError(error)) return false;
        throw error;
      }
    },
    catch: (cause) =>
      new VaultVersionHistoryError({
        code: "GIT_FAILED",
        message: `Failed to probe .git directory in ${vaultRoot}`,
        cause,
      }),
  });

interface ResolvedNotePaths {
  readonly resolvedRoot: string;
  readonly resolvedNoteAbs: string;
  readonly relativePosix: string;
}

const resolveNote = (
  vaultRoot: string,
  relativePath: string,
): Effect.Effect<ResolvedNotePaths, VaultVersionHistoryError> =>
  Effect.gen(function* () {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) {
      return yield* new VaultVersionHistoryError({
        code: "PATH_INVALID",
        message: `Invalid note path: ${relativePath}`,
      });
    }
    if (!normalized.toLowerCase().endsWith(NOTE_FILE_EXTENSION)) {
      return yield* new VaultVersionHistoryError({
        code: "PATH_INVALID",
        message: `Path must be a markdown note: ${relativePath}`,
      });
    }
    const resolvedRoot = yield* Effect.tryPromise({
      try: () => fs.realpath(path.resolve(vaultRoot)),
      catch: (cause) =>
        new VaultVersionHistoryError({
          code: "PATH_INVALID",
          message: `Failed to resolve vault root: ${vaultRoot}`,
          cause,
        }),
    });
    const candidate = path.resolve(resolvedRoot, normalized);
    const resolvedNoteAbs = yield* Effect.tryPromise({
      try: () => fs.realpath(candidate),
      catch: (cause) =>
        isNotFoundError(cause)
          ? new VaultVersionHistoryError({
              code: "NOT_FOUND",
              message: `Note not found: ${relativePath}`,
              cause,
            })
          : new VaultVersionHistoryError({
              code: "PATH_INVALID",
              message: `Failed to resolve note path: ${relativePath}`,
              cause,
            }),
    });
    if (!isWithinVaultRoot(resolvedRoot, resolvedNoteAbs)) {
      return yield* new VaultVersionHistoryError({
        code: "PATH_ESCAPE",
        message: `Path escapes vault root: ${relativePath}`,
      });
    }
    return {
      resolvedRoot,
      resolvedNoteAbs,
      relativePosix: toPosixPath(normalized),
    };
  });

const fromSafeVaultWriteError = (error: SafeVaultWriteError): VaultVersionHistoryError =>
  new VaultVersionHistoryError({
    code: error.code === "PATH_ESCAPE" ? "PATH_ESCAPE" : "PATH_INVALID",
    message:
      error.code === "PATH_ESCAPE"
        ? `Path escapes vault root: ${error.path}`
        : `Invalid vault path: ${error.path}`,
    cause: error,
  });

const parseRevisions = (
  raw: string,
): ReadonlyArray<{
  hash: string;
  timestamp: string;
  message: string;
}> => {
  const lines = raw.split("\n");
  const out: Array<{ hash: string; timestamp: string; message: string }> = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    const firstSep = line.indexOf("|");
    if (firstSep === -1) continue;
    const secondSep = line.indexOf("|", firstSep + 1);
    if (secondSep === -1) continue;
    const hash = line.slice(0, firstSep).trim();
    const timestamp = line.slice(firstSep + 1, secondSep).trim();
    const message = line.slice(secondSep + 1);
    if (hash.length === 0 || !SHA_PATTERN.test(hash)) continue;
    if (timestamp.length === 0) continue;
    out.push({ hash, timestamp, message });
  }
  return out;
};

export const makeVaultVersionHistory = Effect.gen(function* () {
  const projects = yield* ProjectionProjectRepository;
  const fileSystem = yield* EffectFileSystem.FileSystem;
  const pathService = yield* EffectPath.Path;

  const loadVaultRoot = (projectId: ProjectId): Effect.Effect<string, VaultVersionHistoryError> =>
    projects.getById({ projectId }).pipe(
      Effect.mapError(
        (cause) =>
          new VaultVersionHistoryError({
            code: "PROJECT_NOT_FOUND",
            message: `Failed to load project ${projectId}`,
            cause,
          }),
      ),
      Effect.flatMap((projectOption) =>
        Option.match(projectOption, {
          onNone: () =>
            Effect.fail(
              new VaultVersionHistoryError({
                code: "PROJECT_NOT_FOUND",
                message: `Project ${projectId} was not found`,
              }),
            ),
          onSome: (project) => {
            if (project.kind !== "vault") {
              return Effect.fail(
                new VaultVersionHistoryError({
                  code: "KIND_MISMATCH",
                  message: `Project ${projectId} is not a vault (kind=${project.kind ?? "code"})`,
                }),
              );
            }
            return Effect.succeed(project.workspaceRoot);
          },
        }),
      ),
    );

  const getVersionHistory: VaultVersionHistoryShape["getVersionHistory"] = Effect.fn(
    "VaultVersionHistory.getVersionHistory",
  )(function* (input) {
    const vaultRoot = yield* loadVaultRoot(input.projectId);
    const { resolvedRoot, relativePosix } = yield* resolveNote(vaultRoot, input.relativePath);

    const hasGit = yield* checkGitDirectory(resolvedRoot);
    if (!hasGit) {
      return { available: false, reason: "no-git" } satisfies VaultGetVersionHistoryResult;
    }

    // TODO(plan-19): migrate to VcsDriver.
    const result = yield* Effect.tryPromise({
      try: () =>
        runProcess("git", ["log", "--follow", "--format=%H|%ai|%s", "--", relativePosix], {
          cwd: resolvedRoot,
          timeoutMs: GIT_LOG_TIMEOUT_MS,
          outputMode: "truncate",
        }),
      catch: (cause) =>
        new VaultVersionHistoryError({
          code: "GIT_FAILED",
          message: `git log failed for ${relativePosix}`,
          cause,
        }),
    });

    const revisions = parseRevisions(result.stdout);
    if (revisions.length === 0) {
      return { available: false, reason: "untracked" } satisfies VaultGetVersionHistoryResult;
    }
    return { available: true, revisions } satisfies VaultGetVersionHistoryResult;
  });

  const revertToVersion: VaultVersionHistoryShape["revertToVersion"] = Effect.fn(
    "VaultVersionHistory.revertToVersion",
  )(function* (input) {
    if (!SHA_PATTERN.test(input.hash)) {
      return yield* new VaultVersionHistoryError({
        code: "REVISION_NOT_FOUND",
        message: `Invalid commit hash: ${input.hash}`,
      });
    }

    const vaultRoot = yield* loadVaultRoot(input.projectId);
    const { resolvedRoot, relativePosix } = yield* resolveNote(vaultRoot, input.relativePath);

    const hasGit = yield* checkGitDirectory(resolvedRoot);
    if (!hasGit) {
      return yield* new VaultVersionHistoryError({
        code: "GIT_UNAVAILABLE",
        message: `Vault is not a git repository: ${resolvedRoot}`,
      });
    }

    // TODO(plan-19): migrate to VcsDriver.
    const showResult = yield* Effect.tryPromise({
      try: () =>
        runProcess("git", ["show", `${input.hash}:${relativePosix}`], {
          cwd: resolvedRoot,
          timeoutMs: GIT_SHOW_TIMEOUT_MS,
          outputMode: "error",
          allowNonZeroExit: true,
        }),
      catch: (cause) =>
        new VaultVersionHistoryError({
          code: "GIT_FAILED",
          message: `git show failed for ${input.hash}:${relativePosix}`,
          cause,
        }),
    });
    if (showResult.code !== 0) {
      return yield* new VaultVersionHistoryError({
        code: "REVISION_NOT_FOUND",
        message: `Revision ${input.hash} does not contain ${relativePosix}`,
      });
    }

    yield* safeVaultWrite(resolvedRoot, relativePosix, showResult.stdout).pipe(
      Effect.mapError(fromSafeVaultWriteError),
      Effect.provideService(EffectFileSystem.FileSystem, fileSystem),
      Effect.provideService(EffectPath.Path, pathService),
    );

    // TODO(plan-19): migrate to VcsDriver.
    yield* Effect.tryPromise({
      try: () =>
        runProcess("git", ["add", "--", relativePosix], {
          cwd: resolvedRoot,
          timeoutMs: GIT_COMMIT_TIMEOUT_MS,
        }),
      catch: (cause) =>
        new VaultVersionHistoryError({
          code: "GIT_FAILED",
          message: `git add failed for ${relativePosix}`,
          cause,
        }),
    });

    const message = `Revert ${relativePosix} to ${input.hash.slice(0, 7)}`;
    // TODO(plan-19): migrate to VcsDriver.
    const commitResult = yield* Effect.tryPromise({
      try: () =>
        runProcess("git", ["commit", "-m", message, "--", relativePosix], {
          cwd: resolvedRoot,
          timeoutMs: GIT_COMMIT_TIMEOUT_MS,
          allowNonZeroExit: true,
        }),
      catch: (cause) =>
        new VaultVersionHistoryError({
          code: "GIT_FAILED",
          message: `git commit failed for ${relativePosix}`,
          cause,
        }),
    });

    if (commitResult.code !== 0) {
      const stderr = commitResult.stderr.trim();
      const stdout = commitResult.stdout.trim();
      const combined = `${stdout}\n${stderr}`.toLowerCase();
      if (combined.includes("nothing to commit") || combined.includes("nothing added to commit")) {
        return { newCommitHash: null } satisfies VaultRevertToVersionResult;
      }
      return yield* new VaultVersionHistoryError({
        code: "GIT_FAILED",
        message: `git commit failed: ${stderr.length > 0 ? stderr : stdout}`,
      });
    }

    // TODO(plan-19): migrate to VcsDriver.
    const headResult = yield* Effect.tryPromise({
      try: () =>
        runProcess("git", ["rev-parse", "HEAD"], {
          cwd: resolvedRoot,
          timeoutMs: GIT_LOG_TIMEOUT_MS,
        }),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));

    const newCommitHash =
      headResult && headResult.code === 0 && headResult.stdout.trim().length > 0
        ? headResult.stdout.trim()
        : null;

    return { newCommitHash } satisfies VaultRevertToVersionResult;
  });

  return { getVersionHistory, revertToVersion } satisfies VaultVersionHistoryShape;
});

export const VaultVersionHistoryLive = Layer.effect(VaultVersionHistory, makeVaultVersionHistory);
