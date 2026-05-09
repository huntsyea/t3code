import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const VAULT_PATH_MAX_LENGTH = 512;

export const VaultReadNoteInput = Schema.Struct({
  projectId: ProjectId,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(VAULT_PATH_MAX_LENGTH)),
});
export type VaultReadNoteInput = typeof VaultReadNoteInput.Type;

export const VaultReadNoteResult = Schema.Struct({
  content: Schema.String,
  mtime: IsoDateTime,
  size: NonNegativeInt,
});
export type VaultReadNoteResult = typeof VaultReadNoteResult.Type;

export const VaultEntryKind = Schema.Literals(["file", "dir"]);
export type VaultEntryKind = typeof VaultEntryKind.Type;

export const VaultEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  kind: VaultEntryKind,
  relativePath: TrimmedNonEmptyString,
  mtime: IsoDateTime,
  size: NonNegativeInt,
});
export type VaultEntry = typeof VaultEntry.Type;

export const VaultListEntriesInput = Schema.Struct({
  projectId: ProjectId,
  relativeDir: Schema.String.check(Schema.isMaxLength(VAULT_PATH_MAX_LENGTH)),
});
export type VaultListEntriesInput = typeof VaultListEntriesInput.Type;

export const VaultListEntriesResult = Schema.Struct({
  entries: Schema.Array(VaultEntry),
});
export type VaultListEntriesResult = typeof VaultListEntriesResult.Type;

const VAULT_NOTE_MAX_BYTES = 5 * 1024 * 1024;

export const VaultWriteNoteInput = Schema.Struct({
  projectId: ProjectId,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(VAULT_PATH_MAX_LENGTH)),
  content: Schema.String.check(Schema.isMaxLength(VAULT_NOTE_MAX_BYTES)),
});
export type VaultWriteNoteInput = typeof VaultWriteNoteInput.Type;

export const VaultWriteNoteResult = Schema.Struct({
  mtime: IsoDateTime,
  size: NonNegativeInt,
});
export type VaultWriteNoteResult = typeof VaultWriteNoteResult.Type;

export const VaultReaderErrorCode = Schema.Literals([
  "PROJECT_NOT_FOUND",
  "KIND_MISMATCH",
  "PATH_ESCAPE",
  "PATH_INVALID",
  "NOT_FOUND",
  "READ_FAILED",
]);
export type VaultReaderErrorCode = typeof VaultReaderErrorCode.Type;

export class VaultReaderError extends Schema.TaggedErrorClass<VaultReaderError>()(
  "VaultReaderError",
  {
    code: VaultReaderErrorCode,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const VaultWriterErrorCode = Schema.Literals([
  "PROJECT_NOT_FOUND",
  "KIND_MISMATCH",
  "PATH_ESCAPE",
  "PATH_INVALID",
  "WRITE_FAILED",
]);
export type VaultWriterErrorCode = typeof VaultWriterErrorCode.Type;

export class VaultWriterError extends Schema.TaggedErrorClass<VaultWriterError>()(
  "VaultWriterError",
  {
    code: VaultWriterErrorCode,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const VaultFileEventKind = Schema.Literals(["added", "changed", "removed", "renamed"]);
export type VaultFileEventKind = typeof VaultFileEventKind.Type;

/**
 * Domain event emitted by the vault file watcher when a `.md` file inside a
 * vault project is added, changed, removed, or renamed by an external process.
 *
 * Paths are POSIX-style (forward slashes), relative to the vault root, with
 * no leading separator. `oldRelativePath` is only present for `renamed`
 * events.
 */
export const VaultFileEvent = Schema.Struct({
  projectId: ProjectId,
  kind: VaultFileEventKind,
  relativePath: TrimmedNonEmptyString,
  oldRelativePath: Schema.optional(TrimmedNonEmptyString),
});
export type VaultFileEvent = typeof VaultFileEvent.Type;

export const VaultSubscribeFileEventsInput = Schema.Struct({
  projectId: ProjectId,
});
export type VaultSubscribeFileEventsInput = typeof VaultSubscribeFileEventsInput.Type;

export const VaultWatcherErrorCode = Schema.Literals([
  "PROJECT_NOT_FOUND",
  "KIND_MISMATCH",
  "WATCH_FAILED",
]);
export type VaultWatcherErrorCode = typeof VaultWatcherErrorCode.Type;

export class VaultWatcherError extends Schema.TaggedErrorClass<VaultWatcherError>()(
  "VaultWatcherError",
  {
    code: VaultWatcherErrorCode,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
