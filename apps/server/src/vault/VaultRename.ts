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
  ProjectId,
  VaultRenameError,
  VaultRenameNoteInput,
  VaultRenameNoteResult,
} from "@t3tools/contracts";
import { parseWikilinks } from "@t3tools/shared/markdown/wikilink";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { VaultIndex } from "./VaultIndex.ts";
import { safeVaultWrite, SafeVaultWriteError } from "./SafeVaultWrite.ts";

const NOTE_FILE_EXTENSION = ".md";

export interface VaultRenameShape {
  readonly renameNote: (
    input: VaultRenameNoteInput,
  ) => Effect.Effect<VaultRenameNoteResult, VaultRenameError>;
}

export class VaultRename extends Context.Service<VaultRename, VaultRenameShape>()(
  "t3/vault/VaultRename",
) {}

const isNotFoundError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: string }).code === "ENOENT";

const isExistsError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: string }).code === "EEXIST";

const normalizeRelativePath = (input: string): string | null => {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes("\0")) return null;
  if (path.isAbsolute(trimmed)) return null;
  return trimmed;
};

const realpathAncestor = async (candidate: string): Promise<string> => {
  let current = candidate;
  const missing: string[] = [];
  while (true) {
    try {
      const resolved = await fs.realpath(current);
      return missing.reduce((acc, segment) => path.join(acc, segment), resolved);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
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

const fromSafeVaultWriteError = (error: SafeVaultWriteError): VaultRenameError =>
  new VaultRenameError({
    code: error.code === "PATH_ESCAPE" ? "PATH_ESCAPE" : "PATH_INVALID",
    message:
      error.code === "PATH_ESCAPE"
        ? `Path escapes vault root: ${error.path}`
        : `Invalid vault path: ${error.path}`,
    cause: error,
  });

const basenameWithoutMd = (relativePath: string): string => {
  const base = path.posix.basename(relativePath.replaceAll("\\", "/"));
  return base.endsWith(NOTE_FILE_EXTENSION) ? base.slice(0, -NOTE_FILE_EXTENSION.length) : base;
};

interface ResolvedPaths {
  readonly resolvedRoot: string;
  readonly oldAbs: string;
  readonly newAbs: string;
}

const resolvePaths = (
  vaultRoot: string,
  oldRelative: string,
  newRelative: string,
): Effect.Effect<ResolvedPaths, VaultRenameError> =>
  Effect.gen(function* () {
    const oldNormalized = normalizeRelativePath(oldRelative);
    const newNormalized = normalizeRelativePath(newRelative);
    if (!oldNormalized) {
      return yield* new VaultRenameError({
        code: "PATH_INVALID",
        message: `Invalid old vault path: ${oldRelative}`,
      });
    }
    if (!newNormalized) {
      return yield* new VaultRenameError({
        code: "PATH_INVALID",
        message: `Invalid new vault path: ${newRelative}`,
      });
    }
    if (!oldNormalized.toLowerCase().endsWith(NOTE_FILE_EXTENSION)) {
      return yield* new VaultRenameError({
        code: "PATH_INVALID",
        message: `Old path must be a markdown note: ${oldRelative}`,
      });
    }
    if (!newNormalized.toLowerCase().endsWith(NOTE_FILE_EXTENSION)) {
      return yield* new VaultRenameError({
        code: "PATH_INVALID",
        message: `New path must be a markdown note: ${newRelative}`,
      });
    }

    const resolvedRoot = yield* Effect.tryPromise({
      try: () => fs.realpath(path.resolve(vaultRoot)),
      catch: (cause) =>
        new VaultRenameError({
          code: "PATH_INVALID",
          message: `Failed to resolve vault root: ${vaultRoot}`,
          cause,
        }),
    });

    const oldCandidate = path.resolve(resolvedRoot, oldNormalized);
    const oldResolved = yield* Effect.tryPromise({
      try: () => fs.realpath(oldCandidate),
      catch: (cause) =>
        isNotFoundError(cause)
          ? new VaultRenameError({
              code: "NOT_FOUND",
              message: `Note not found: ${oldRelative}`,
              cause,
            })
          : new VaultRenameError({
              code: "PATH_INVALID",
              message: `Failed to resolve old path: ${oldRelative}`,
              cause,
            }),
    });
    if (!isWithinVaultRoot(resolvedRoot, oldResolved)) {
      return yield* new VaultRenameError({
        code: "PATH_ESCAPE",
        message: `Path escapes vault root: ${oldRelative}`,
      });
    }

    const newCandidate = path.resolve(resolvedRoot, newNormalized);
    const newResolved = yield* Effect.tryPromise({
      try: () => realpathAncestor(newCandidate),
      catch: (cause) =>
        new VaultRenameError({
          code: "PATH_INVALID",
          message: `Failed to resolve new path: ${newRelative}`,
          cause,
        }),
    });
    if (!isWithinVaultRoot(resolvedRoot, newResolved)) {
      return yield* new VaultRenameError({
        code: "PATH_ESCAPE",
        message: `Path escapes vault root: ${newRelative}`,
      });
    }

    return { resolvedRoot, oldAbs: oldResolved, newAbs: newResolved };
  });

const ensureDir = (filePath: string): Effect.Effect<void, VaultRenameError> =>
  Effect.tryPromise({
    try: () => fs.mkdir(path.dirname(filePath), { recursive: true }),
    catch: (cause) =>
      new VaultRenameError({
        code: "RENAME_FAILED",
        message: `Failed to create destination directory for: ${filePath}`,
        cause,
      }),
  }).pipe(Effect.asVoid);

const performRename = (oldAbs: string, newAbs: string): Effect.Effect<void, VaultRenameError> =>
  Effect.gen(function* () {
    const exists = yield* Effect.tryPromise({
      try: async () => {
        try {
          await fs.access(newAbs);
          return true;
        } catch {
          return false;
        }
      },
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      return yield* new VaultRenameError({
        code: "ALREADY_EXISTS",
        message: `Destination already exists: ${newAbs}`,
      });
    }
    yield* ensureDir(newAbs);
    yield* Effect.tryPromise({
      try: () => fs.rename(oldAbs, newAbs),
      catch: (cause) =>
        isExistsError(cause)
          ? new VaultRenameError({
              code: "ALREADY_EXISTS",
              message: `Destination already exists: ${newAbs}`,
              cause,
            })
          : isNotFoundError(cause)
            ? new VaultRenameError({
                code: "NOT_FOUND",
                message: `Note not found at: ${oldAbs}`,
                cause,
              })
            : new VaultRenameError({
                code: "RENAME_FAILED",
                message: `Failed to rename note: ${oldAbs} -> ${newAbs}`,
                cause,
              }),
    });
  });

const rewriteWikilinkBody = (
  content: string,
  oldBasename: string,
  newBasename: string,
): { readonly next: string; readonly count: number } => {
  const matches = parseWikilinks(content).filter((match) => match.basename === oldBasename);
  if (matches.length === 0) return { next: content, count: 0 };

  let next = content;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i]!;
    const [start, end] = match.span;
    next = `${next.slice(0, start)}[[${newBasename}]]${next.slice(end)}`;
  }
  return { next, count: matches.length };
};

const rewriteSourceFile = (
  resolvedRoot: string,
  sourceRelative: string,
  oldBasename: string,
  newBasename: string,
): Effect.Effect<boolean, VaultRenameError, EffectFileSystem.FileSystem | EffectPath.Path> =>
  Effect.gen(function* () {
    const sourceAbs = path.resolve(resolvedRoot, sourceRelative);
    const realpathResult = yield* Effect.tryPromise({
      try: () => fs.realpath(sourceAbs),
      catch: (cause) => ({ cause }) as { readonly cause: unknown },
    }).pipe(
      Effect.matchEffect({
        onFailure: ({ cause }) =>
          isNotFoundError(cause)
            ? Effect.succeed(null)
            : Effect.fail(
                new VaultRenameError({
                  code: "REWRITE_FAILED",
                  message: `Failed to resolve source path: ${sourceRelative}`,
                  cause,
                }),
              ),
        onSuccess: (resolved) => Effect.succeed(resolved),
      }),
    );

    if (realpathResult === null) return false;
    const sourceResolved = realpathResult;
    if (!isWithinVaultRoot(resolvedRoot, sourceResolved)) return false;

    const content = yield* Effect.tryPromise({
      try: () => fs.readFile(sourceResolved, "utf8"),
      catch: (cause) =>
        new VaultRenameError({
          code: "REWRITE_FAILED",
          message: `Failed to read source file for wikilink rewrite: ${sourceRelative}`,
          cause,
        }),
    });

    const { next, count } = rewriteWikilinkBody(content, oldBasename, newBasename);
    if (count === 0 || next === content) return false;

    yield* safeVaultWrite(resolvedRoot, sourceRelative, next).pipe(
      Effect.mapError(fromSafeVaultWriteError),
    );
    return true;
  });

export const makeVaultRename = Effect.gen(function* () {
  const projects = yield* ProjectionProjectRepository;
  const vaultIndex = yield* VaultIndex;
  const fileSystem = yield* EffectFileSystem.FileSystem;
  const pathService = yield* EffectPath.Path;

  const loadVaultRoot = (projectId: ProjectId): Effect.Effect<string, VaultRenameError> =>
    projects.getById({ projectId }).pipe(
      Effect.mapError(
        (cause) =>
          new VaultRenameError({
            code: "PROJECT_NOT_FOUND",
            message: `Failed to load project ${projectId}`,
            cause,
          }),
      ),
      Effect.flatMap((projectOption) =>
        Option.match(projectOption, {
          onNone: () =>
            Effect.fail(
              new VaultRenameError({
                code: "PROJECT_NOT_FOUND",
                message: `Project ${projectId} was not found`,
              }),
            ),
          onSome: (project) => {
            if (project.kind !== "vault") {
              return Effect.fail(
                new VaultRenameError({
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

  const renameNote: VaultRenameShape["renameNote"] = Effect.fn("VaultRename.renameNote")(
    function* (input) {
      const vaultRoot = yield* loadVaultRoot(input.projectId);
      const { resolvedRoot, oldAbs, newAbs } = yield* resolvePaths(
        vaultRoot,
        input.oldRelativePath,
        input.newRelativePath,
      );

      if (oldAbs === newAbs) {
        return { rewrittenSources: 0 } satisfies VaultRenameNoteResult;
      }

      yield* performRename(oldAbs, newAbs);

      const oldBasename = basenameWithoutMd(input.oldRelativePath);
      const newBasename = basenameWithoutMd(input.newRelativePath);

      if (oldBasename === newBasename) {
        return { rewrittenSources: 0 } satisfies VaultRenameNoteResult;
      }

      const sources = yield* vaultIndex.getBacklinks(input.projectId, oldBasename).pipe(
        Effect.mapError(
          (cause) =>
            new VaultRenameError({
              code: "REWRITE_FAILED",
              message: `Failed to load backlinks for ${oldBasename}`,
              cause,
            }),
        ),
      );

      let rewritten = 0;
      for (const sourceRelative of sources) {
        const changed = yield* rewriteSourceFile(
          resolvedRoot,
          sourceRelative,
          oldBasename,
          newBasename,
        ).pipe(
          Effect.provideService(EffectFileSystem.FileSystem, fileSystem),
          Effect.provideService(EffectPath.Path, pathService),
        );
        if (changed) rewritten += 1;
      }

      return { rewrittenSources: rewritten } satisfies VaultRenameNoteResult;
    },
  );

  return { renameNote } satisfies VaultRenameShape;
});

export const VaultRenameLive = Layer.effect(VaultRename, makeVaultRename);
