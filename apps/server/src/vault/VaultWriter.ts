import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  ProjectId,
  VaultWriteNoteInput,
  VaultWriteNoteResult,
  VaultWriterError,
} from "@t3tools/contracts";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { safeVaultWrite, SafeVaultWriteError } from "./SafeVaultWrite.ts";

export interface VaultWriterShape {
  readonly writeNote: (
    input: VaultWriteNoteInput,
  ) => Effect.Effect<VaultWriteNoteResult, VaultWriterError>;
}

export class VaultWriter extends Context.Service<VaultWriter, VaultWriterShape>()(
  "t3/vault/VaultWriter",
) {}

const epochIso = DateTime.formatIso(DateTime.makeUnsafe(0));

const formatMtime = (info: FileSystem.File.Info): string =>
  Option.match(info.mtime, {
    onNone: () => epochIso,
    onSome: (date) => DateTime.formatIso(DateTime.fromDateUnsafe(date)),
  });

const fromSafeVaultWriteError = (error: SafeVaultWriteError): VaultWriterError =>
  new VaultWriterError({
    code: error.code,
    message:
      error.code === "PATH_ESCAPE"
        ? `Path escapes vault root: ${error.path}`
        : `Invalid vault path: ${error.path}`,
    cause: error,
  });

export const makeVaultWriter = Effect.gen(function* () {
  const projects = yield* ProjectionProjectRepository;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const loadVaultRoot = (projectId: ProjectId): Effect.Effect<string, VaultWriterError> =>
    projects.getById({ projectId }).pipe(
      Effect.mapError(
        (cause) =>
          new VaultWriterError({
            code: "PROJECT_NOT_FOUND",
            message: `Failed to load project ${projectId}`,
            cause,
          }),
      ),
      Effect.flatMap((projectOption) =>
        Option.match(projectOption, {
          onNone: () =>
            Effect.fail(
              new VaultWriterError({
                code: "PROJECT_NOT_FOUND",
                message: `Project ${projectId} was not found`,
              }),
            ),
          onSome: (project) => {
            if (project.kind !== "vault") {
              return Effect.fail(
                new VaultWriterError({
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

  const writeNote: VaultWriterShape["writeNote"] = Effect.fn("VaultWriter.writeNote")(
    function* (input) {
      const vaultRoot = yield* loadVaultRoot(input.projectId);

      yield* safeVaultWrite(vaultRoot, input.relativePath, input.content).pipe(
        Effect.mapError(fromSafeVaultWriteError),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const resolvedRoot = yield* fileSystem.realPath(path.resolve(vaultRoot)).pipe(
        Effect.mapError(
          (cause) =>
            new VaultWriterError({
              code: "WRITE_FAILED",
              message: `Failed to resolve vault root after write: ${vaultRoot}`,
              cause,
            }),
        ),
      );

      const absolutePath = path.resolve(resolvedRoot, input.relativePath);
      const stat = yield* fileSystem.stat(absolutePath).pipe(
        Effect.mapError(
          (cause) =>
            new VaultWriterError({
              code: "WRITE_FAILED",
              message: `Failed to stat note after write: ${input.relativePath}`,
              cause,
            }),
        ),
      );

      return {
        mtime: formatMtime(stat),
        size: Number(stat.size),
      } satisfies VaultWriteNoteResult;
    },
  );

  return { writeNote } satisfies VaultWriterShape;
});

export const VaultWriterLive = Layer.effect(VaultWriter, makeVaultWriter);
