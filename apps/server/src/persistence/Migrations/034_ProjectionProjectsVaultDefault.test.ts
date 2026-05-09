import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("034_ProjectionProjectsVaultDefault", (it) => {
  it.effect("updates code projects to vault and changes the kind default when supported", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at,
          kind
        )
        VALUES
          (
            'project-code',
            'Code Project',
            '/tmp/code',
            NULL,
            '[]',
            '2026-05-09T00:00:00.000Z',
            '2026-05-09T00:00:00.000Z',
            NULL,
            'code'
          ),
          (
            'project-vault',
            'Vault Project',
            '/tmp/vault',
            NULL,
            '[]',
            '2026-05-09T00:00:00.000Z',
            '2026-05-09T00:00:00.000Z',
            NULL,
            'vault'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 34 });

      const rows = yield* sql<{ readonly projectId: string; readonly kind: string }>`
        SELECT project_id AS "projectId", kind
        FROM projection_projects
        ORDER BY project_id
      `;
      assert.deepStrictEqual(rows, [
        { projectId: "project-code", kind: "vault" },
        { projectId: "project-vault", kind: "vault" },
      ]);

      const columns = yield* sql<{
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
        readonly pk: number;
      }>`
        PRAGMA table_info(projection_projects)
      `;
      const kindColumn = columns.find((column) => column.name === "kind");
      assert.ok(kindColumn);
      assert.equal(kindColumn.type, "TEXT");
      assert.equal(kindColumn.notnull, 1);
      assert.equal(kindColumn.pk, 0);

      const versionRows = yield* sql<{ readonly version: string }>`
        SELECT sqlite_version() AS version
      `;
      const version = versionRows[0]?.version ?? "0.0.0";
      const [major = 0, minor = 0] = version.split(".").map((part) => Number(part));
      if (major > 3 || (major === 3 && minor >= 35)) {
        assert.equal(kindColumn.dflt_value, "'vault'");
      }
    }),
  );
});
