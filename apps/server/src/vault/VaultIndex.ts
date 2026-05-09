import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ProjectId } from "@t3tools/contracts";

export class VaultIndexError extends Schema.TaggedErrorClass<VaultIndexError>()("VaultIndexError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `Vault index error in ${this.operation}: ${this.detail}`;
  }
}

export interface VaultIndexUpsertNoteInput {
  readonly title: string | null;
  readonly mtime: number;
  readonly size: number;
  readonly frontmatterJson: string | null;
  readonly body: string;
}

export interface VaultIndexWikilinkInput {
  readonly targetBasename: string;
  readonly spanStart: number;
  readonly spanEnd: number;
}

export interface VaultIndexSearchHit {
  readonly relativePath: string;
  readonly title: string | null;
  readonly snippet: string;
  readonly score: number;
}

export interface VaultIndexTagCount {
  readonly tag: string;
  readonly count: number;
}

export interface VaultIndexShape {
  readonly upsertNote: (
    vaultId: ProjectId,
    relativePath: string,
    input: VaultIndexUpsertNoteInput,
  ) => Effect.Effect<void, VaultIndexError>;

  readonly deleteNote: (
    vaultId: ProjectId,
    relativePath: string,
  ) => Effect.Effect<void, VaultIndexError>;

  readonly upsertWikilinks: (
    vaultId: ProjectId,
    sourcePath: string,
    links: ReadonlyArray<VaultIndexWikilinkInput>,
  ) => Effect.Effect<void, VaultIndexError>;

  readonly upsertTags: (
    vaultId: ProjectId,
    sourcePath: string,
    tags: ReadonlyArray<string>,
  ) => Effect.Effect<void, VaultIndexError>;

  readonly searchFTS: (
    vaultId: ProjectId,
    query: string,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<VaultIndexSearchHit>, VaultIndexError>;

  readonly getBacklinks: (
    vaultId: ProjectId,
    targetBasename: string,
  ) => Effect.Effect<ReadonlyArray<string>, VaultIndexError>;

  readonly listTags: (
    vaultId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<VaultIndexTagCount>, VaultIndexError>;
}

export class VaultIndex extends Context.Service<VaultIndex, VaultIndexShape>()(
  "t3/vault/VaultIndex",
) {}

const FTS5_SPECIAL_CHARS = /["'()*:^\-+]/g;

/**
 * Sanitize an FTS5 MATCH query string by stripping special syntax characters
 * and wrapping each remaining term as a phrase literal. This prevents query
 * injection (e.g. `foo"; DROP TABLE`) while still allowing multi-term search.
 *
 * Multi-word phrases (separated by whitespace) are AND-joined.
 */
const sanitizeFtsQuery = (raw: string): string => {
  const cleaned = raw.replace(FTS5_SPECIAL_CHARS, " ").trim();
  if (cleaned.length === 0) return "";
  const tokens = cleaned.split(/\s+/u).filter((token) => token.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((token) => `"${token}"`).join(" AND ");
};

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 500;

const clampLimit = (input: number | undefined): number => {
  if (input === undefined || !Number.isFinite(input) || input <= 0) {
    return DEFAULT_SEARCH_LIMIT;
  }
  const truncated = Math.floor(input);
  return truncated > MAX_SEARCH_LIMIT ? MAX_SEARCH_LIMIT : truncated;
};

const toError = (operation: string, detail: string) => (cause: unknown) =>
  new VaultIndexError({ operation, detail, cause });

export const makeVaultIndex = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertNote: VaultIndexShape["upsertNote"] = (vaultId, relativePath, input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM vault_notes
            WHERE vault_id = ${vaultId} AND relative_path = ${relativePath}
          `;
          yield* sql`
            INSERT INTO vault_notes (
              vault_id, relative_path, title, mtime, size, frontmatter_json
            ) VALUES (
              ${vaultId}, ${relativePath}, ${input.title}, ${input.mtime}, ${input.size}, ${input.frontmatterJson}
            )
          `;
          yield* sql`
            DELETE FROM vault_notes_fts5
            WHERE vault_id = ${vaultId} AND relative_path = ${relativePath}
          `;
          yield* sql`
            INSERT INTO vault_notes_fts5 (vault_id, relative_path, title, body)
            VALUES (${vaultId}, ${relativePath}, ${input.title ?? ""}, ${input.body})
          `;
        }),
      )
      .pipe(Effect.mapError(toError("VaultIndex.upsertNote", "Failed to upsert note")));

  const deleteNote: VaultIndexShape["deleteNote"] = (vaultId, relativePath) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM vault_notes
            WHERE vault_id = ${vaultId} AND relative_path = ${relativePath}
          `;
          yield* sql`
            DELETE FROM vault_notes_fts5
            WHERE vault_id = ${vaultId} AND relative_path = ${relativePath}
          `;
          yield* sql`
            DELETE FROM vault_wikilinks
            WHERE vault_id = ${vaultId} AND source_path = ${relativePath}
          `;
          yield* sql`
            DELETE FROM vault_tags
            WHERE vault_id = ${vaultId} AND source_path = ${relativePath}
          `;
        }),
      )
      .pipe(Effect.mapError(toError("VaultIndex.deleteNote", "Failed to delete note")));

  const upsertWikilinks: VaultIndexShape["upsertWikilinks"] = (vaultId, sourcePath, links) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM vault_wikilinks
            WHERE vault_id = ${vaultId} AND source_path = ${sourcePath}
          `;
          for (const link of links) {
            yield* sql`
              INSERT INTO vault_wikilinks (
                vault_id, source_path, target_basename, span_start, span_end
              ) VALUES (
                ${vaultId}, ${sourcePath}, ${link.targetBasename}, ${link.spanStart}, ${link.spanEnd}
              )
            `;
          }
        }),
      )
      .pipe(Effect.mapError(toError("VaultIndex.upsertWikilinks", "Failed to upsert wikilinks")));

  const upsertTags: VaultIndexShape["upsertTags"] = (vaultId, sourcePath, tags) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM vault_tags
            WHERE vault_id = ${vaultId} AND source_path = ${sourcePath}
          `;
          for (const tag of tags) {
            yield* sql`
              INSERT INTO vault_tags (vault_id, source_path, tag)
              VALUES (${vaultId}, ${sourcePath}, ${tag})
            `;
          }
        }),
      )
      .pipe(Effect.mapError(toError("VaultIndex.upsertTags", "Failed to upsert tags")));

  const searchFTS: VaultIndexShape["searchFTS"] = (vaultId, query, limit) =>
    Effect.gen(function* () {
      const sanitized = sanitizeFtsQuery(query);
      if (sanitized.length === 0) {
        return [] as ReadonlyArray<VaultIndexSearchHit>;
      }
      const effectiveLimit = clampLimit(limit);

      const rows = yield* sql<{
        readonly relative_path: string;
        readonly title: string | null;
        readonly snippet: string;
        readonly score: number;
      }>`
        SELECT
          relative_path,
          title,
          snippet(vault_notes_fts5, 3, '<mark>', '</mark>', '…', 16) AS snippet,
          bm25(vault_notes_fts5) AS score
        FROM vault_notes_fts5
        WHERE vault_id = ${vaultId} AND vault_notes_fts5 MATCH ${sanitized}
        ORDER BY score
        LIMIT ${effectiveLimit}
      `.pipe(Effect.mapError(toError("VaultIndex.searchFTS", "Failed to execute FTS query")));

      return rows.map((row) => ({
        relativePath: row.relative_path,
        title: row.title,
        snippet: row.snippet,
        score: row.score,
      }));
    });

  const getBacklinks: VaultIndexShape["getBacklinks"] = (vaultId, targetBasename) =>
    sql<{ readonly source_path: string }>`
      SELECT source_path
      FROM vault_wikilinks
      WHERE vault_id = ${vaultId} AND target_basename = ${targetBasename}
    `.pipe(
      Effect.map((rows) => rows.map((row) => row.source_path)),
      Effect.mapError(toError("VaultIndex.getBacklinks", "Failed to load backlinks")),
    );

  const listTags: VaultIndexShape["listTags"] = (vaultId) =>
    sql<{ readonly tag: string; readonly count: number }>`
      SELECT tag, COUNT(*) AS count
      FROM vault_tags
      WHERE vault_id = ${vaultId}
      GROUP BY tag
      ORDER BY count DESC, tag ASC
    `.pipe(
      Effect.map((rows) => rows.map((row) => ({ tag: row.tag, count: row.count }))),
      Effect.mapError(toError("VaultIndex.listTags", "Failed to list tags")),
    );

  return {
    upsertNote,
    deleteNote,
    upsertWikilinks,
    upsertTags,
    searchFTS,
    getBacklinks,
    listTags,
  } satisfies VaultIndexShape;
});

export const VaultIndexLive = Layer.effect(VaultIndex, makeVaultIndex);
