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

export const VaultRenameNoteInput = Schema.Struct({
  projectId: ProjectId,
  oldRelativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(VAULT_PATH_MAX_LENGTH)),
  newRelativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(VAULT_PATH_MAX_LENGTH)),
});
export type VaultRenameNoteInput = typeof VaultRenameNoteInput.Type;

export const VaultRenameNoteResult = Schema.Struct({
  /** Number of source files whose wikilinks were rewritten as part of the rename. */
  rewrittenSources: NonNegativeInt,
});
export type VaultRenameNoteResult = typeof VaultRenameNoteResult.Type;

export const VaultRenameErrorCode = Schema.Literals([
  "PROJECT_NOT_FOUND",
  "KIND_MISMATCH",
  "PATH_ESCAPE",
  "PATH_INVALID",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "RENAME_FAILED",
  "REWRITE_FAILED",
]);
export type VaultRenameErrorCode = typeof VaultRenameErrorCode.Type;

export class VaultRenameError extends Schema.TaggedErrorClass<VaultRenameError>()(
  "VaultRenameError",
  {
    code: VaultRenameErrorCode,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const VaultResolveBasenameInput = Schema.Struct({
  projectId: ProjectId,
  basename: TrimmedNonEmptyString.check(Schema.isMaxLength(VAULT_PATH_MAX_LENGTH)),
});
export type VaultResolveBasenameInput = typeof VaultResolveBasenameInput.Type;

export const VaultResolvedNote = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  /**
   * Modification time recorded in the vault index, in milliseconds since
   * epoch. Newer entries (higher mtime) are returned first so callers can
   * pick the most recently edited match when a basename collision exists.
   */
  mtime: NonNegativeInt,
});
export type VaultResolvedNote = typeof VaultResolvedNote.Type;

export const VaultResolveBasenameResult = Schema.Struct({
  matches: Schema.Array(VaultResolvedNote),
});
export type VaultResolveBasenameResult = typeof VaultResolveBasenameResult.Type;

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

export const VaultIndexUpdateKind = Schema.Literals(["upserted", "removed"]);
export type VaultIndexUpdateKind = typeof VaultIndexUpdateKind.Type;

/**
 * Notification emitted by the vault index reactor after a file change has been
 * applied to the persistent index. Web clients use this to refresh derived
 * panels (backlinks, tag list, search results) without re-running the full
 * search query speculatively on every file event.
 */
export const VaultIndexUpdate = Schema.Struct({
  projectId: ProjectId,
  kind: VaultIndexUpdateKind,
  relativePath: TrimmedNonEmptyString,
});
export type VaultIndexUpdate = typeof VaultIndexUpdate.Type;

export const VaultSubscribeIndexUpdatesInput = Schema.Struct({
  projectId: ProjectId,
});
export type VaultSubscribeIndexUpdatesInput = typeof VaultSubscribeIndexUpdatesInput.Type;

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

/**
 * Vault index queries (`vault.listTags`, `vault.notesByTag`, `vault.search`).
 * All inputs are vault-scoped via `projectId`; the server verifies the
 * project exists and is a vault before reading from `vault_tags` /
 * `vault_notes_fts5`.
 */
export const VaultIndexQueryErrorCode = Schema.Literals([
  "PROJECT_NOT_FOUND",
  "KIND_MISMATCH",
  "QUERY_FAILED",
]);
export type VaultIndexQueryErrorCode = typeof VaultIndexQueryErrorCode.Type;

export class VaultIndexQueryError extends Schema.TaggedErrorClass<VaultIndexQueryError>()(
  "VaultIndexQueryError",
  {
    code: VaultIndexQueryErrorCode,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const VaultListTagsInput = Schema.Struct({
  projectId: ProjectId,
});
export type VaultListTagsInput = typeof VaultListTagsInput.Type;

export const VaultTagCount = Schema.Struct({
  tag: TrimmedNonEmptyString,
  count: NonNegativeInt,
});
export type VaultTagCount = typeof VaultTagCount.Type;

export const VaultListTagsResult = Schema.Struct({
  tags: Schema.Array(VaultTagCount),
});
export type VaultListTagsResult = typeof VaultListTagsResult.Type;

export const VaultNotesByTagInput = Schema.Struct({
  projectId: ProjectId,
  tag: TrimmedNonEmptyString.check(Schema.isMaxLength(VAULT_PATH_MAX_LENGTH)),
});
export type VaultNotesByTagInput = typeof VaultNotesByTagInput.Type;

export const VaultTaggedNote = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  title: Schema.NullOr(Schema.String),
});
export type VaultTaggedNote = typeof VaultTaggedNote.Type;

export const VaultNotesByTagResult = Schema.Struct({
  notes: Schema.Array(VaultTaggedNote),
});
export type VaultNotesByTagResult = typeof VaultNotesByTagResult.Type;

const VAULT_SEARCH_MAX_QUERY_LENGTH = 512;
const VAULT_SEARCH_MAX_LIMIT = 500;

export const VaultSearchInput = Schema.Struct({
  projectId: ProjectId,
  query: Schema.String.check(Schema.isMaxLength(VAULT_SEARCH_MAX_QUERY_LENGTH)),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(VAULT_SEARCH_MAX_LIMIT),
    ),
  ),
});
export type VaultSearchInput = typeof VaultSearchInput.Type;

export const VaultSearchHit = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  title: Schema.NullOr(Schema.String),
  snippet: Schema.String,
  score: Schema.Number,
});
export type VaultSearchHit = typeof VaultSearchHit.Type;

export const VaultSearchResult = Schema.Struct({
  hits: Schema.Array(VaultSearchHit),
});
export type VaultSearchResult = typeof VaultSearchResult.Type;

export const VaultGetBacklinksInput = Schema.Struct({
  projectId: ProjectId,
  /**
   * Basename of the target note (without `.md` extension). Backlinks are
   * stored against the wikilink target basename, not the full relative path.
   */
  targetBasename: TrimmedNonEmptyString.check(Schema.isMaxLength(VAULT_PATH_MAX_LENGTH)),
});
export type VaultGetBacklinksInput = typeof VaultGetBacklinksInput.Type;

export const VaultBacklink = Schema.Struct({
  /**
   * POSIX-style relative path of the source note (the note containing the
   * `[[targetBasename]]` wikilink).
   */
  sourcePath: TrimmedNonEmptyString,
});
export type VaultBacklink = typeof VaultBacklink.Type;

export const VaultGetBacklinksResult = Schema.Struct({
  backlinks: Schema.Array(VaultBacklink),
});
export type VaultGetBacklinksResult = typeof VaultGetBacklinksResult.Type;
