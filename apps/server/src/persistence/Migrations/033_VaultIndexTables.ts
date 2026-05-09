import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // vault_notes: metadata only (no content column). Content lives on disk; FTS5 owns the indexed copy.
  yield* sql`
    CREATE TABLE IF NOT EXISTS vault_notes (
      vault_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      title TEXT,
      mtime INTEGER,
      size INTEGER,
      frontmatter_json TEXT,
      PRIMARY KEY (vault_id, relative_path)
    )
  `;

  // vault_wikilinks: source → target basename links extracted from notes.
  yield* sql`
    CREATE TABLE IF NOT EXISTS vault_wikilinks (
      vault_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      target_basename TEXT NOT NULL,
      span_start INTEGER,
      span_end INTEGER
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_wikilinks_target
    ON vault_wikilinks (vault_id, target_basename)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_wikilinks_source
    ON vault_wikilinks (vault_id, source_path)
  `;

  // vault_tags: per-note tag occurrences (deduplication is the writer's job).
  yield* sql`
    CREATE TABLE IF NOT EXISTS vault_tags (
      vault_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      tag TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_tags_tag
    ON vault_tags (vault_id, tag)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_tags_source
    ON vault_tags (vault_id, source_path)
  `;

  // vault_notes_fts5: REGULAR (self-content) FTS5 — supports snippet() and bm25().
  // vault_id and relative_path are UNINDEXED (filter columns, not searched).
  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS vault_notes_fts5
    USING fts5(
      vault_id UNINDEXED,
      relative_path UNINDEXED,
      title,
      body,
      tokenize = 'porter unicode61'
    )
  `;
});
