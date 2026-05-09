
## F2 Code Quality Review — 2026-05-09 05:30 UTC

### Test results
- Format (bun fmt): PASS (1126 files)
- Lint (bun lint): 0 errors, 15 warnings (pre-existing)
- Tests shared: 173/173 PASS
- Tests contracts: 149/149 PASS
- Tests server vault: 42/42 PASS
- Build: PASS

### Typecheck: FAIL (156 errors)

Atlas-pivot introduced typecheck regressions that block AGENTS.md gate.

#### apps/server/src/vault/SafeVaultWrite.ts
- L4-5 — uses `node:fs/promises` and `node:path` directly, violating effect-rule plugin (`effect(nodeBuiltinImport)`). Should import `FileSystem`/`Path` from `effect`.
- L80-81 — declared signature `Effect.Effect<void, SafeVaultWriteError>` (R = never, no PlatformError) but `Effect.gen` body actually requires `FileSystem | Path` and produces `PlatformError`. Either widen the signature or wrap/translate platform errors.

#### apps/server/src/ws.ts
- L1151 — `vaultWatcher.subscribe(...)` returns `Effect<() => void, VaultWatcherError, Scope>` but `Stream.callback` expects `Effect<unknown, never, Scope>`. Pipe with `Effect.orDie` or map error to never.
- L1162 — same pattern with `vaultIndexReactor.subscribe(...)`.

#### apps/server/src/server.test.ts
- L929, 945, 962, 992, 1017, 4247, 4342 (and other call sites) — test layers no longer provide all required vault services after T2/T7/T9/T17 added `ThreadTabPersistence | VaultIndex | VaultIndexReactor | VaultReader | VaultRename | VaultVersionHistory | VaultWatcher | VaultWriter`. Test runtime layer needs these provided (or substituted with stubs).

#### apps/server/src/bin.ts and bin.test.ts
- Multiple call sites missing `ProjectionProjectRepository` in Effect context after T1 (`ProjectionProject` kind discriminator). Need to thread the repository layer through CLI.

#### apps/server/src/persistence/Migrations/031_ProjectionProjectsKind.test.ts
- L33 — `pk` property accessed on row type that doesn't expose it (TS2339). Cast or change query to include `pk`.

### Code quality scan (key new files)
Files scanned: SafeVaultWrite, VaultReader, VaultIndex, VaultWatcher, VaultRename, VaultIndexReactor, TabStrip.tsx, MarkdownEditor.tsx, wikilink.ts, tag.ts.
- `as any` / `@ts-ignore`: NONE
- Empty catch blocks: NONE
- console.log in production: NONE
- Commented-out code: NONE
- Generic AI-slop names (`data`, `result`, etc.): only `result` in 3 places (`VaultVersionHistory.ts:238`, `MarkdownEditor.tsx:268,282`) — minor, locally scoped to short blocks; acceptable.

### Verdict
REJECT — typecheck must pass per AGENTS.md.
