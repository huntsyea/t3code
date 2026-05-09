import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("031_ProjectionProjectsKind", (it) => {
  it.effect("adds the kind column to projection_projects", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 30 });
      yield* runMigrations({ toMigrationInclusive: 31 });

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
      assert.equal(kindColumn.name, "kind");
      assert.equal(kindColumn.type, "TEXT");
      assert.equal(kindColumn.notnull, 1);
      assert.equal(kindColumn.pk, 0);
      assert.equal(kindColumn.dflt_value, "'code'");
    }),
  );
});
