import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectId } from "@t3tools/contracts";

import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { VaultIndex, VaultIndexLive } from "./VaultIndex.ts";

const TestLayer = VaultIndexLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

const layer = it.layer(TestLayer);

const makeVaultId = (label: string): ProjectId =>
  ProjectId.make(`vault-${label}-${crypto.randomUUID()}`);

layer("VaultIndex", (it) => {
  it.effect("upsertNote stores metadata and FTS row, scoped by vault_id", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const index = yield* VaultIndex;
      const vaultId = makeVaultId("upsert");

      yield* index.upsertNote(vaultId, "notes/alpha.md", {
        title: "Alpha",
        mtime: 1000,
        size: 42,
        frontmatterJson: null,
        body: "the quick brown fox jumps over the lazy dog",
      });

      const hits = yield* index.searchFTS(vaultId, "quick fox");
      assert.equal(hits.length, 1);
      const hit = hits[0];
      if (!hit) throw new Error("expected hit");
      assert.equal(hit.relativePath, "notes/alpha.md");
      assert.ok(hit.snippet.length > 0);
      assert.ok(hit.snippet.includes("<mark>"));
    }),
  );

  it.effect("vault isolation: vault B cannot read vault A notes via FTS", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const index = yield* VaultIndex;
      const vaultA = makeVaultId("iso-a");
      const vaultB = makeVaultId("iso-b");

      yield* index.upsertNote(vaultA, "secret.md", {
        title: "Secret A",
        mtime: 1,
        size: 10,
        frontmatterJson: null,
        body: "alpha-secret-token",
      });
      yield* index.upsertNote(vaultB, "public.md", {
        title: "Public B",
        mtime: 1,
        size: 10,
        frontmatterJson: null,
        body: "beta-public-token",
      });

      const fromB = yield* index.searchFTS(vaultB, "alpha-secret-token");
      assert.equal(fromB.length, 0);

      const fromA = yield* index.searchFTS(vaultA, "alpha-secret-token");
      assert.equal(fromA.length, 1);
    }),
  );

  it.effect("vault isolation: backlinks and tags do not leak across vaults", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const index = yield* VaultIndex;
      const vaultA = makeVaultId("xref-a");
      const vaultB = makeVaultId("xref-b");

      yield* index.upsertWikilinks(vaultA, "src.md", [
        { targetBasename: "shared", spanStart: 0, spanEnd: 8 },
      ]);
      yield* index.upsertWikilinks(vaultB, "other.md", [
        { targetBasename: "shared", spanStart: 0, spanEnd: 8 },
      ]);

      const backlinksA = yield* index.getBacklinks(vaultA, "shared");
      const backlinksB = yield* index.getBacklinks(vaultB, "shared");
      assert.deepEqual(Array.from(backlinksA), ["src.md"]);
      assert.deepEqual(Array.from(backlinksB), ["other.md"]);

      yield* index.upsertTags(vaultA, "src.md", ["work", "todo"]);
      yield* index.upsertTags(vaultB, "other.md", ["work"]);

      const tagsA = yield* index.listTags(vaultA);
      const tagsB = yield* index.listTags(vaultB);
      assert.equal(tagsA.length, 2);
      assert.equal(tagsB.length, 1);
      assert.equal(tagsB[0]?.tag, "work");
      assert.equal(tagsB[0]?.count, 1);
    }),
  );

  it.effect("upsertNote replaces previous body in FTS (no stale snippets)", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const index = yield* VaultIndex;
      const vaultId = makeVaultId("replace");

      yield* index.upsertNote(vaultId, "n.md", {
        title: "N",
        mtime: 1,
        size: 1,
        frontmatterJson: null,
        body: "original sentinel-token",
      });
      yield* index.upsertNote(vaultId, "n.md", {
        title: "N",
        mtime: 2,
        size: 1,
        frontmatterJson: null,
        body: "rewritten replacement-token",
      });

      const stale = yield* index.searchFTS(vaultId, "sentinel-token");
      const fresh = yield* index.searchFTS(vaultId, "replacement-token");
      assert.equal(stale.length, 0);
      assert.equal(fresh.length, 1);
    }),
  );

  it.effect("deleteNote removes from all four tables", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const index = yield* VaultIndex;
      const vaultId = makeVaultId("delete");

      yield* index.upsertNote(vaultId, "doomed.md", {
        title: "Doomed",
        mtime: 1,
        size: 1,
        frontmatterJson: null,
        body: "purgable content",
      });
      yield* index.upsertWikilinks(vaultId, "doomed.md", [
        { targetBasename: "x", spanStart: 0, spanEnd: 1 },
      ]);
      yield* index.upsertTags(vaultId, "doomed.md", ["a", "b"]);

      yield* index.deleteNote(vaultId, "doomed.md");

      const hits = yield* index.searchFTS(vaultId, "purgable");
      const backlinks = yield* index.getBacklinks(vaultId, "x");
      const tags = yield* index.listTags(vaultId);
      assert.equal(hits.length, 0);
      assert.deepEqual(Array.from(backlinks), []);
      assert.equal(tags.length, 0);
    }),
  );

  it.effect("searchFTS sanitizes injection attempts and returns no spurious matches", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const index = yield* VaultIndex;
      const vaultId = makeVaultId("inject");

      yield* index.upsertNote(vaultId, "n.md", {
        title: "N",
        mtime: 1,
        size: 1,
        frontmatterJson: null,
        body: "harmless body text",
      });

      const malicious = yield* index.searchFTS(vaultId, '"; DROP TABLE vault_notes_fts5; --');
      assert.ok(Array.isArray(malicious));

      const empty = yield* index.searchFTS(vaultId, '""()');
      assert.equal(empty.length, 0);

      const wildcard = yield* index.searchFTS(vaultId, "harmless*");
      assert.ok(Array.isArray(wildcard));

      const stillAlive = yield* index.searchFTS(vaultId, "harmless");
      assert.equal(stillAlive.length, 1);
    }),
  );

  it.effect("upsertWikilinks replaces prior links for the same source", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const index = yield* VaultIndex;
      const vaultId = makeVaultId("wikilink");

      yield* index.upsertWikilinks(vaultId, "src.md", [
        { targetBasename: "old", spanStart: 0, spanEnd: 3 },
      ]);
      yield* index.upsertWikilinks(vaultId, "src.md", [
        { targetBasename: "new", spanStart: 0, spanEnd: 3 },
      ]);

      const oldBacklinks = yield* index.getBacklinks(vaultId, "old");
      const newBacklinks = yield* index.getBacklinks(vaultId, "new");
      assert.deepEqual(Array.from(oldBacklinks), []);
      assert.deepEqual(Array.from(newBacklinks), ["src.md"]);
    }),
  );

  it.effect("listTags aggregates counts grouped by tag", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const index = yield* VaultIndex;
      const vaultId = makeVaultId("listtags");

      yield* index.upsertTags(vaultId, "a.md", ["work", "todo"]);
      yield* index.upsertTags(vaultId, "b.md", ["work"]);
      yield* index.upsertTags(vaultId, "c.md", ["work", "idea"]);

      const tags = yield* index.listTags(vaultId);
      const work = tags.find((t) => t.tag === "work");
      const todo = tags.find((t) => t.tag === "todo");
      const idea = tags.find((t) => t.tag === "idea");
      assert.equal(work?.count, 3);
      assert.equal(todo?.count, 1);
      assert.equal(idea?.count, 1);
    }),
  );
});
