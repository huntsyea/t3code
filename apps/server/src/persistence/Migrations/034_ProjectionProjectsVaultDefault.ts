import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const supportsDropColumn = (version: string) => {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number(part));
  return major > 3 || (major === 3 && minor >= 35);
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_projects
    SET kind = 'vault'
    WHERE kind = 'code'
  `;

  const columns = yield* sql<{
    readonly name: string;
    readonly dflt_value: string | null;
  }>`
    PRAGMA table_info(projection_projects)
  `;
  const kindColumn = columns.find((column) => column.name === "kind");

  if (kindColumn?.dflt_value === "'vault'") {
    return;
  }

  const versionRows = yield* sql<{ readonly version: string }>`
    SELECT sqlite_version() AS version
  `;
  const version = versionRows[0]?.version ?? "0.0.0";

  // SQLite gained ALTER TABLE ... DROP COLUMN in 3.35. Older runtimes have
  // already had existing rows normalized above; application inserts explicitly
  // write kind = 'vault', so leaving the legacy DEFAULT is safe there.
  if (!supportsDropColumn(version)) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_projects
    RENAME COLUMN kind TO kind_old
  `;

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'vault'
  `;

  yield* sql`
    UPDATE projection_projects
    SET kind = CASE kind_old
      WHEN 'code' THEN 'vault'
      ELSE kind_old
    END
  `;

  yield* sql`
    ALTER TABLE projection_projects
    DROP COLUMN kind_old
  `;
});
