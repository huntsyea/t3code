import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  ProjectId,
  VaultEntry,
  VaultListEntriesInput,
  VaultListEntriesResult,
  VaultReaderError,
  VaultReadNoteInput,
  VaultReadNoteResult,
} from "@t3tools/contracts";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";

const NOTE_FILE_EXTENSION = ".md";

export interface VaultReaderShape {
  readonly readNote: (
    input: VaultReadNoteInput,
  ) => Effect.Effect<VaultReadNoteResult, VaultReaderError>;

  readonly listEntries: (
    input: VaultListEntriesInput,
  ) => Effect.Effect<VaultListEntriesResult, VaultReaderError>;
}

export class VaultReader extends Context.Service<VaultReader, VaultReaderShape>()(
  "t3/vault/VaultReader",
) {}

const isNotFoundPlatformError = (cause: unknown): boolean => {
  if (typeof cause !== "object" || cause === null) return false;
  const tag = (cause as { _tag?: string })._tag;
  if (tag !== "PlatformError" && tag !== "SystemError") return false;
  const reason = (cause as { reason?: unknown }).reason;
  if (typeof reason === "string") return reason === "NotFound";
  if (typeof reason === "object" && reason !== null) {
    return (reason as { _tag?: string })._tag === "NotFound";
  }
  return false;
};

function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

function compareEntries(a: VaultEntry, b: VaultEntry): number {
  if (a.kind !== b.kind) {
    return a.kind === "dir" ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

export const makeVaultReader = Effect.gen(function* () {
  const projects = yield* ProjectionProjectRepository;
  const vcsRegistry = yield* VcsDriverRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  function isAtOrWithinVaultRoot(vaultRoot: string, resolvedPath: string): boolean {
    if (resolvedPath === vaultRoot) return true;
    const relative = path.relative(vaultRoot, resolvedPath);
    if (relative.length === 0 || relative === ".") return true;
    if (relative === ".." || relative.startsWith(`..${path.sep}`)) return false;
    if (path.isAbsolute(relative)) return false;

    if (process.platform === "darwin") {
      const lowerRoot = vaultRoot.toLowerCase();
      const lowerResolved = resolvedPath.toLowerCase();
      return lowerResolved === lowerRoot || lowerResolved.startsWith(lowerRoot + path.sep);
    }

    return resolvedPath === vaultRoot || resolvedPath.startsWith(vaultRoot + path.sep);
  }

  function normalizeRelativePath(input: string): string | null {
    const trimmed = input.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.includes("\0")) return null;
    if (path.isAbsolute(trimmed)) return null;
    return trimmed;
  }

  function toPosixRelative(input: string): string {
    return input.replaceAll("\\", "/");
  }

  const loadVaultRoot = (projectId: ProjectId): Effect.Effect<string, VaultReaderError> =>
    projects.getById({ projectId }).pipe(
      Effect.mapError(
        (cause) =>
          new VaultReaderError({
            code: "PROJECT_NOT_FOUND",
            message: `Failed to load project ${projectId}`,
            cause,
          }),
      ),
      Effect.flatMap((projectOption) =>
        Option.match(projectOption, {
          onNone: () =>
            Effect.fail(
              new VaultReaderError({
                code: "PROJECT_NOT_FOUND",
                message: `Project ${projectId} was not found`,
              }),
            ),
          onSome: (project) => {
            if (project.kind !== "vault") {
              return Effect.fail(
                new VaultReaderError({
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

  const resolveSandboxedPath = (input: {
    readonly vaultRoot: string;
    readonly relativePath: string;
    readonly allowRoot: boolean;
  }): Effect.Effect<
    { readonly absPath: string; readonly resolvedRoot: string },
    VaultReaderError
  > =>
    Effect.gen(function* () {
      const resolvedRoot = yield* fileSystem.realPath(path.resolve(input.vaultRoot)).pipe(
        Effect.mapError(
          (cause) =>
            new VaultReaderError({
              code: "PATH_INVALID",
              message: `Failed to resolve vault root: ${input.vaultRoot}`,
              cause,
            }),
        ),
      );

      const trimmedRelative = input.relativePath.trim();
      const isRoot = trimmedRelative.length === 0;

      if (isRoot && !input.allowRoot) {
        return yield* new VaultReaderError({
          code: "PATH_INVALID",
          message: "A relative path is required.",
        });
      }

      const candidatePath = isRoot
        ? resolvedRoot
        : (() => {
            const normalized = normalizeRelativePath(trimmedRelative);
            return normalized === null ? null : path.resolve(resolvedRoot, normalized);
          })();

      if (candidatePath === null) {
        return yield* new VaultReaderError({
          code: "PATH_INVALID",
          message: `Invalid relative path: ${input.relativePath}`,
        });
      }

      const resolvedCandidate = yield* fileSystem.realPath(candidatePath).pipe(
        Effect.mapError((cause) =>
          isNotFoundPlatformError(cause)
            ? new VaultReaderError({
                code: "NOT_FOUND",
                message: `Path not found: ${input.relativePath || "."}`,
                cause,
              })
            : new VaultReaderError({
                code: "PATH_INVALID",
                message: `Failed to resolve path: ${input.relativePath || "."}`,
                cause,
              }),
        ),
      );

      if (!isAtOrWithinVaultRoot(resolvedRoot, resolvedCandidate)) {
        return yield* new VaultReaderError({
          code: "PATH_ESCAPE",
          message: `Path escapes vault root: ${input.relativePath}`,
        });
      }

      return { absPath: resolvedCandidate, resolvedRoot };
    });

  const filterIgnoredPathsIfTracked = (
    cwd: string,
    relativePaths: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<string>, never> =>
    vcsRegistry.detect({ cwd }).pipe(
      Effect.flatMap((handle) =>
        handle
          ? handle.driver.filterIgnoredPaths(cwd, relativePaths).pipe(
              Effect.map((paths) => paths as ReadonlyArray<string>),
              Effect.catch(() => Effect.succeed(relativePaths)),
            )
          : Effect.succeed(relativePaths),
      ),
      Effect.catch(() => Effect.succeed(relativePaths)),
    );

  const epochIso = DateTime.formatIso(DateTime.makeUnsafe(0));
  const formatMtime = (info: FileSystem.File.Info): string =>
    Option.match(info.mtime, {
      onNone: () => epochIso,
      onSome: (date) => DateTime.formatIso(DateTime.fromDateUnsafe(date)),
    });

  const toSize = (info: FileSystem.File.Info): number => Number(info.size);

  const readNote: VaultReaderShape["readNote"] = Effect.fn("VaultReader.readNote")(
    function* (input) {
      const vaultRoot = yield* loadVaultRoot(input.projectId);
      const { absPath } = yield* resolveSandboxedPath({
        vaultRoot,
        relativePath: input.relativePath,
        allowRoot: false,
      });

      const stat = yield* fileSystem.stat(absPath).pipe(
        Effect.mapError((cause) =>
          isNotFoundPlatformError(cause)
            ? new VaultReaderError({
                code: "NOT_FOUND",
                message: `File not found: ${input.relativePath}`,
                cause,
              })
            : new VaultReaderError({
                code: "READ_FAILED",
                message: `Failed to stat file: ${input.relativePath}`,
                cause,
              }),
        ),
      );

      if (stat.type !== "File") {
        return yield* new VaultReaderError({
          code: "READ_FAILED",
          message: `Path is not a file: ${input.relativePath}`,
        });
      }

      const content = yield* fileSystem.readFileString(absPath).pipe(
        Effect.mapError(
          (cause) =>
            new VaultReaderError({
              code: "READ_FAILED",
              message: `Failed to read file: ${input.relativePath}`,
              cause,
            }),
        ),
      );

      return {
        content,
        mtime: formatMtime(stat),
        size: toSize(stat),
      };
    },
  );

  const listEntries: VaultReaderShape["listEntries"] = Effect.fn("VaultReader.listEntries")(
    function* (input) {
      const vaultRoot = yield* loadVaultRoot(input.projectId);
      const { absPath, resolvedRoot } = yield* resolveSandboxedPath({
        vaultRoot,
        relativePath: input.relativeDir,
        allowRoot: true,
      });

      const dirStat = yield* fileSystem.stat(absPath).pipe(
        Effect.mapError((cause) =>
          isNotFoundPlatformError(cause)
            ? new VaultReaderError({
                code: "NOT_FOUND",
                message: `Directory not found: ${input.relativeDir || "."}`,
                cause,
              })
            : new VaultReaderError({
                code: "READ_FAILED",
                message: `Failed to stat directory: ${input.relativeDir || "."}`,
                cause,
              }),
        ),
      );

      if (dirStat.type !== "Directory") {
        return yield* new VaultReaderError({
          code: "READ_FAILED",
          message: `Path is not a directory: ${input.relativeDir || "."}`,
        });
      }

      const names = yield* fileSystem.readDirectory(absPath).pipe(
        Effect.mapError(
          (cause) =>
            new VaultReaderError({
              code: "READ_FAILED",
              message: `Failed to read directory: ${input.relativeDir || "."}`,
              cause,
            }),
        ),
      );

      const candidatesWithStats = yield* Effect.forEach(
        names.filter((name) => name && !isHiddenName(name)),
        (name) =>
          Effect.gen(function* () {
            const childAbs = path.join(absPath, name);
            const childStat = yield* fileSystem
              .stat(childAbs)
              .pipe(Effect.catch(() => Effect.succeed(null)));
            if (!childStat) return null;
            const isDir = childStat.type === "Directory";
            const isFile = childStat.type === "File";
            if (!isDir && !isFile) return null;
            if (isFile && !name.toLowerCase().endsWith(NOTE_FILE_EXTENSION)) return null;

            const childRelativeFromRoot = toPosixRelative(path.relative(resolvedRoot, childAbs));
            return {
              name,
              kind: isDir ? ("dir" as const) : ("file" as const),
              relativePath: childRelativeFromRoot,
              stat: childStat,
            };
          }),
        { concurrency: 16 },
      );

      const candidates = candidatesWithStats.filter(
        (candidate): candidate is NonNullable<typeof candidate> => candidate !== null,
      );

      const candidatePaths = candidates.map((candidate) => candidate.relativePath);
      const allowed = new Set(yield* filterIgnoredPathsIfTracked(resolvedRoot, candidatePaths));
      const allowedCandidates =
        candidatePaths.length === allowed.size &&
        candidatePaths.every((value) => allowed.has(value))
          ? candidates
          : candidates.filter((candidate) => allowed.has(candidate.relativePath));

      const entries: VaultEntry[] = allowedCandidates.map((candidate) => ({
        name: candidate.name,
        kind: candidate.kind,
        relativePath: candidate.relativePath,
        mtime: formatMtime(candidate.stat),
        size: toSize(candidate.stat),
      }));

      entries.sort(compareEntries);

      return { entries };
    },
  );

  return { readNote, listEntries } satisfies VaultReaderShape;
});

export const VaultReaderLive = Layer.effect(VaultReader, makeVaultReader);
