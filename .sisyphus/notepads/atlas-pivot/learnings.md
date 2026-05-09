# Atlas Pivot — Learnings

## Project Structure

- `node:sqlite` (NOT better-sqlite3) — DatabaseSync API, Node 22.16+
- FTS5 is built-in to bundled SQLite; no extension needed
- DB path: `~/.t3/userdata/state.sqlite`
- Migrations: numbered files under `apps/server/src/persistence/Migrations/` (001–030 exist; T1 adds 031)
- Push events: two patterns:
  1. Domain events: via `OrchestrationEngine.dispatch` → `streamDomainEvents`
  2. Subsystem notifications: per-service `subscribe(handler)` + `subscribe*` WS RPC (mirror terminal manager pattern at `apps/server/src/ws.ts:1119-1126`)
  - Tab state and vault FS events use pattern 2

## Key File Locations

- WS server: `apps/server/src/ws.ts` (NOT wsServer.ts)
- Projection projects: `apps/server/src/persistence/Layers/ProjectionProjects.ts`
- Project migration origin: `apps/server/src/persistence/Migrations/005_Projections.ts`
- Protocol scheme: `apps/desktop/src/electron/ElectronProtocol.ts` (`DESKTOP_SCHEME = "t3"`)
- App identity: `apps/desktop/src/app/DesktopAppIdentity.ts`
- User data dir: `apps/desktop/src/app/DesktopEnvironment.ts:154-205` (baseDir = `~/.t3`, userDataDirName = `"t3code"`)
- Terminal manager subscribe pattern: `apps/server/src/terminal/Layers/Manager.ts`

## Architecture Constraints

- `atomicWrite.ts` has NO path sandboxing — all vault writes MUST go through `SafeVaultWrite`
- `Sidebar.tsx` is 3472 lines — thread list logic MUST NOT be touched
- `ChatMarkdown.tsx` is 628 lines — must NOT be forked/replaced
- `ComposerPromptEditor.tsx` uses Lexical — coexists with new CM6 editor
- Phase 3 rebrand is IRREVERSIBLE — only after Phase 2 GO/NO-GO gate

## Vault Write Boundary

- `SafeVaultWrite` must realpath both the vault root and the target path; macOS temp roots may resolve through `/private/var`, so comparing against the canonical root avoids false escape rejections.
- Missing nested directories need recursive ancestor resolution before the final atomic write; plain `realpath(parent)` is not enough for fresh note paths like `notes/today.txt`.
- The vault discipline test should exempt `SafeVaultWrite.ts` itself; it is the only intentional direct `atomicWrite` import under `apps/server/src/vault/`.

## Contracts / Tabs

- Branded ids already exist in `packages/contracts/src/baseSchemas.ts`: `ThreadId`, `ProjectId`, `CommandId`, `EventId`, `MessageId`, `TurnId`, etc.
- Reuse `ThreadId` for chat tabs and import `ProjectId`/`ThreadId` from `./baseSchemas.ts` in new tab contracts.
- Contract re-exports flow through `packages/contracts/src/index.ts`; add new schema files there so downstream imports stay stable.

## 2026-05-09

- `project.create` / `project.created` now need `kind` threaded through contracts, decider, projector, persistence, and shell snapshot mapping.
- `projection_projects.kind` is safest as a defaulted SQLite column with PRAGMA-guarded migration; existing rows stay `code`.
- Web project state needed a compatibility default so older in-memory fixtures still map cleanly while project `kind` is rolling out.

## Task 2 — VaultReader (vault.readNote / vault.listEntries)

- `VaultReader` Effect service mirrors `SafeVaultWrite`: realpath the vault root, realpath the candidate, then assert prefix containment with macOS case-insensitive guard. Reads MUST realpath both root and target so symlinks-leaving-root resolve to PATH_ESCAPE rather than leaking content.
- `effect/FileSystem.realPath` returns `PlatformError` whose `_tag === "PlatformError"` and whose `reason` is itself a tagged object (`{ _tag: "NotFound", module, method, ... }`), NOT the legacy `SystemError` shape with `reason: "NotFound"`. `isNotFoundPlatformError` must accept both shapes; the original check silently returned PATH_INVALID for missing files (fixed in this task).
- `Layer.mock(Service)({...})` is the cleanest way to stub `ProjectionProjectRepository` and `VcsDriverRegistry` for unit tests. Provide via `Layer.provide(...)` to `VaultReaderLive` and `provideMerge` `NodeServices.layer` to satisfy `FileSystem` / `Path`.
- macOS tmp directories normalise through `/private/var/folders/...`; tests must rely on `fs.realpath` semantics (already handled by `resolveSandboxedPath`) instead of comparing raw `os.tmpdir()` paths.
- `listEntries` filters direct children only — no recursion — and excludes hidden entries (`startsWith(".")`) plus non-`.md` files. When VCS is detected via `VcsDriverRegistry.detect`, candidate relative paths are passed through `driver.filterIgnoredPaths` so vault `.gitignore` is respected without re-implementing parsing.
- Keep `VaultReader` provisioned via `VaultReaderLayerLive = VaultReaderLive.pipe(Layer.provideMerge(VcsDriverRegistryLayerLive))` and merged into `WorkspaceLayerLive`; the WS handlers in `apps/server/src/ws.ts` then resolve `yield* VaultReader` at startup.
- Pre-existing typecheck failures in `server.test.ts`/`bin.test.ts` (Missing `ThreadTabPersistence | VaultReader | ProjectionProjectRepository` in test contexts) are inherited from earlier tasks — out of scope for this task; my changes do not introduce typecheck errors in `VaultReader.ts` or `test/vault/VaultReader.test.ts`.

## Task 6 — TabStrip Component

- Tab RPCs were already registered in `WsRpcGroup` (rpc.ts:559-565) but the `WsRpcClient` interface had no `tabs` property. Added `tabs` section following the existing `orchestration`/`server`/`terminal` patterns using `transport.request` and `transport.subscribe`.
- Streaming subscription pattern: `subscribeThreadState` uses `RpcInputStreamMethod` (takes `{ threadId }` input), returns an unsubscribe function. On reconnect, the `onResubscribe` callback re-fetches `getThreadState` to restore state.
- Project `kind` check: access via `store.environmentStateById[environmentId].threadShellById[threadId].projectId` → `projectById[projectId].kind`. Component returns `null` for non-`"vault"` projects.
- Environment connection: obtained via `readEnvironmentConnection(environmentId)` from `environments/runtime`. Returns `null` if not yet connected — handled gracefully.
- Effect Schema discriminated unions: `Tab = ChatTab | NoteTab`. TypeScript narrows on `tab.kind === "chat"`, giving direct access to `tab.title` (ChatTab) or `tab.relativePath`/`tab.isDirty` (NoteTab) without needing `Schema.Struct.fields` accessors.
- HTML5 DnD: `draggable` on each tab, `onDragStart` stores source index in ref, `onDragOver` with `preventDefault`, `onDrop` computes new order and calls `tabs.reorderTabs`. No external DnD library needed.
- A11y: `role="tablist"` on container, `role="tab"` on each tab, `aria-selected`, `tabIndex` managed (0 for active, -1 for inactive), Left/Right arrow focus navigation, Enter/Space to activate, ⌘W/Ctrl+W to close active.
- Close button visibility: always `opacity-100` on active tab, `opacity-0 group-hover/tab:opacity-100` on inactive tabs (appears on hover).
- Vitest config: `vitest run --passWithNoTests` — tests run via `bun run test`. Browser tests use separate config `vitest.browser.config.ts`.
