// @effect-diagnostics nodeBuiltinImport:off
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { writeFileStringAtomically as atomicWrite } from "../atomicWrite.ts";

export class SafeVaultWriteError extends Data.TaggedError("SafeVaultWriteError")<{
  readonly code: "PATH_ESCAPE" | "PATH_INVALID" | "WRITE_FAILED";
  readonly path: string;
  readonly cause?: unknown;
}> {}

function normalizeRelativePath(input: string): string | null {
  const normalized = input.trim();
  if (normalized.length === 0) return null;
  if (normalized.includes("\0")) return null;
  if (path.isAbsolute(normalized)) return null;
  return normalized;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

async function realpathCandidate(candidate: string): Promise<string> {
  let current = candidate;
  const missingSegments: string[] = [];

  while (true) {
    try {
      const resolved = await fs.realpath(current);
      return missingSegments.reduce(
        (resolvedPath, segment) => path.join(resolvedPath, segment),
        resolved,
      );
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }

      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isWithinVaultRoot(vaultRoot: string, resolvedPath: string): boolean {
  const relative = path.relative(vaultRoot, resolvedPath);
  if (relative.length === 0 || relative === ".") return false;
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) return false;
  if (path.isAbsolute(relative)) return false;

  if (process.platform === "darwin") {
    const normalizedRoot = vaultRoot.toLowerCase();
    const normalizedResolved = resolvedPath.toLowerCase();
    return (
      normalizedResolved.startsWith(normalizedRoot + path.sep) ||
      normalizedResolved === normalizedRoot
    );
  }

  return resolvedPath.startsWith(vaultRoot + path.sep) || resolvedPath === vaultRoot;
}

export const safeVaultWrite = (
  vaultRoot: string,
  relativePath: string,
  content: string | Uint8Array,
): Effect.Effect<void, SafeVaultWriteError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const normalizedRelativePath = normalizeRelativePath(relativePath);
    if (!normalizedRelativePath) {
      return yield* new SafeVaultWriteError({
        code: "PATH_INVALID",
        path: relativePath,
      });
    }

    const normalizedVaultRoot = path.resolve(vaultRoot);
    const resolvedVaultRoot = yield* Effect.tryPromise({
      try: () => fs.realpath(normalizedVaultRoot),
      catch: () =>
        new SafeVaultWriteError({
          code: "PATH_INVALID",
          path: vaultRoot,
        }),
    });
    const candidatePath = path.resolve(normalizedVaultRoot, normalizedRelativePath);

    const resolvedPath = yield* Effect.tryPromise({
      try: () => realpathCandidate(candidatePath),
      catch: () =>
        new SafeVaultWriteError({
          code: "PATH_INVALID",
          path: relativePath,
        }),
    });

    if (!isWithinVaultRoot(resolvedVaultRoot, resolvedPath)) {
      return yield* new SafeVaultWriteError({
        code: "PATH_ESCAPE",
        path: relativePath,
      });
    }

    const atomicWriteContent =
      typeof content === "string" ? content : new TextDecoder().decode(content);
    return yield* atomicWrite({
      filePath: resolvedPath,
      contents: atomicWriteContent,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SafeVaultWriteError({
            code: "WRITE_FAILED",
            path: relativePath,
            cause,
          }),
      ),
    );
  });
