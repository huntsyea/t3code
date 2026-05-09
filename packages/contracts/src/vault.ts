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
