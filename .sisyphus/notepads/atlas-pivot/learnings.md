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

## Task 7 — VaultFileTree right-side panel + ChatHeader toggle

- Vault RPCs (`vault.listEntries` / `vault.readNote`) were defined in `packages/contracts/src/rpc.ts` and registered in `WsRpcGroup`, but the `WsRpcClient` interface did not yet expose a `vault` namespace. Added one mirroring `projects` (request-only, no streams) so web can call `connection.client.vault.listEntries({ projectId, relativeDir })`.
- Lazy-load discipline: root entries fetch in a single `useEffect` keyed by `projectId`. Each directory expansion fetches its own children only when first opened — `directoriesByPath` records `loading | loaded | error` per path so re-expansion does not refetch. An in-flight `Set` ref prevents duplicate concurrent loads.
- Hooks rules: `useMemo` (`useMemoizedEntries`) must be called unconditionally. Resolve `childState` for every entry node (even files, where it is `undefined`) before the `kind === "dir"` branch.
- ChatHeader pattern: new toolbar buttons follow the existing `Tooltip` + `TooltipTrigger render={<Toggle .../>}` shape. Match `variant="outline" size="xs"` and `className="shrink-0"` for consistent sizing. Vault-only visibility flows in as a `showFileTreeToggle` boolean prop derived from `activeProject?.kind === "vault"`, so ChatHeader stays unaware of store shape.
- LocalStorage: existing `useLocalStorage(key, initial, schema)` hook accepts an Effect `Schema.Codec`. For a plain boolean toggle, `Schema.Boolean` is sufficient. Key namespacing for Atlas pivot: `atlas.fileTreeOpen`.
- Right-panel layout: chat column uses `flex-1`, the vault tree sits adjacent with `w-72 shrink-0` and renders before the existing `PlanSidebar` slot. Hidden below `lg` breakpoint via `hidden lg:flex` to avoid crowding small viewports — mobile users open notes via tabs instead.
- Keyboard navigation: tree items are buttons with `tabIndex=0`; Arrow Up/Down cycles focus across visible buttons inside the `[role="tree"]` container, Arrow Right expands a collapsed dir, Arrow Left collapses an expanded dir, Enter/Space activates (toggle for dirs, open-tab for `.md` files).
- Pre-existing typecheck failures in `apps/server/src/{bin,server}.test.ts`, `vault/SafeVaultWrite.ts`, and `persistence/Migrations/031_ProjectionProjectsKind.test.ts` are inherited from prior tasks (T1–T6) and out of scope for this task; my changes introduce zero new TS errors in web/contracts.

## Task 8 — EmptyWorkspace + "Open chat tab" command

- Server-side `defaultThreadTabState` in `apps/server/src/vault/ThreadTabPersistence.ts:79-89` always seeds a chat tab on first read. Zero-tabs only happens after the user explicitly closes the chat tab (and any notes). EmptyWorkspace must therefore be triggered by tab-state subscription, not by a "first load" flag.
- No `tabs.openChatTab` RPC exists. The chat-tab invariant (`ChatTab.id === ThreadId`, see `packages/contracts/src/tabs.ts:19-24`) means re-opening a chat tab is purely a client-side compose: read state, prepend a `{ kind: "chat", id: threadId, title }` entry, set active, and call `tabs.setThreadState`. Helper extracted to `apps/web/src/components/vault/openChatTab.ts` so both EmptyWorkspace and CommandPalette share the same path.
- Web `Project.kind` is typed as optional (`"code" | "vault" | undefined`) in `apps/web/src/types.ts:87`, so `Map<ProjectId, string>` construction needs `flatMap` filtering of `undefined`, not a plain `map`.
- TabStrip mounting into ChatView is still pending — both T6 (TabStrip) and T8 (EmptyWorkspace) created standalone components that take `{threadId, environmentId}` props but are not yet wired into `apps/web/src/components/ChatView.tsx`. A future task should mount both inside the chat column.
- Pre-existing typecheck failures (`apps/server/src/bin.test.ts`, `server.test.ts`, `SafeVaultWrite.ts`) remain — they were noted as out-of-scope in earlier task learnings. Web app typecheck (`cd apps/web && bun typecheck`) is clean and all 1050 web tests pass.

## Task 10 — VaultIndex (033 migration + Effect service)

- Migration 033 adds 4 tables — all include `vault_id TEXT NOT NULL` for cross-vault isolation:
  - `vault_notes` (PK: vault_id, relative_path) — metadata only, no body column
  - `vault_wikilinks` (+ idx_target, idx_source)
  - `vault_tags` (+ idx_tag, idx_source)
  - `vault_notes_fts5` regular (self-content) FTS5 — **must NOT use contentless** (`content=''`) because contentless mode does not support `snippet()`
- FTS5 query sanitization: strip `["'()*:^\-+]` then wrap each token in `"..."` and AND-join. Defends against `"; DROP TABLE …` style injection attempts at the MATCH layer; SQL-level injection is already blocked by parameterized queries.
- `sql.withTransaction(...)` wraps multi-statement upserts so partial writes (e.g., note row inserted but FTS row missing) cannot leak.
- `it.layer(...)` from `@effect/vitest` builds the Layer ONCE per `describe`. Tests using shared SQLite state must either (a) clean up explicitly, (b) use unique `vault_id` per test (preferred — also exercises `vault_id` filtering naturally).
- Pre-existing rpc.ts bug fixed in passing: `WsVaultSubscribeFileEventsRpc` referenced `VaultSubscribeFileEventsInput` / `VaultFileEvent` / `VaultWatcherError` without importing them, causing a module-load `ReferenceError` that blocked every server test from running. Imports added.

## Task 9 — VaultWatcher (chokidar + subscribe pattern)

- chokidar 5.0.0 (cross-platform, Node ≥20.19) — installed into `apps/server`. Importing `chokidar.watch(paths, options)` is the v5 entry point; exports `FSWatcher` typed `EventEmitter` with `add`/`change`/`unlink`/`error`/`all` events.
- Subscribe pattern (NOT OrchestrationEngine): `VaultWatcher.subscribe(projectId, handler) → unsubscribe` mirrors `TerminalManager.subscribe`. Per-project state held in `SynchronizedRef<Map<projectId, ProjectWatcherEntry>>`; first subscriber starts chokidar, last unsubscriber tears down (refcounted by listener count).
- Path resolution lookup via `ProjectionProjectRepository.getById` (kind must equal `"vault"`) — same shape as `VaultReader.loadVaultRoot`. Keep the lookup in the watcher so the WS handler stays dumb.
- Debounce/batch via `DrainableWorker<readonly VaultFileEvent[]>` — `NodeTimers.setTimeout` (250ms default) collects events into a per-entry `Map<string, VaultFileEvent>` keyed by `${kind}:${relativePath}`, then `worker.enqueue(batch)` ships the batch. Worker ensures `tearDown` drains pending dispatch before closing chokidar so subscribers are guaranteed to see queued events.
- `Layer.scoped` does not exist in this Effect 4.0 beta — use `Layer.effect(Tag, makeFn)` and rely on `Effect.addFinalizer` inside `makeFn` for shutdown drain. `Scope.extend` is replaced by `Scope.provide(scope)`. `Closeable` scope type is exported as `Scope.Closeable`.
- chokidar's `awaitWriteFinish: { stabilityThreshold, pollInterval }` collapses fsync sequences (good for editors that write+truncate). Pair with `ignoreInitial: true` so we don't replay the whole vault on subscribe.
- chokidar `ignored` regex `[/\/\.git\//, /\/\.atlas\//]` matches paths _containing_ those segments — works for nested paths under those directories. Test asserts the option shape passed to chokidar; runtime ignoring is chokidar's responsibility.
- macOS realpath caveat: `os.tmpdir()` returns `/var/folders/...` but realpath resolves to `/private/var/folders/...`. Tests must `await fs.realpath(root)` after creating the temp directory; the watcher itself calls `fileSystem.realPath` so emitted absolute paths must align with the resolved root.
- `// @effect-diagnostics nodeBuiltinImport:off globalTimers:off` directive at top of file suppresses lints when intentionally using `node:timers` — established pattern (see `ThreadTabPersistence.ts:6`).
- `observeRpcStream` in WS handler wraps `Stream.callback<VaultFileEvent>` + `Effect.acquireRelease(subscribe, unsubscribe)` — identical to `subscribeTerminalEvents`. `vault.subscribeFileEvents` RPC is added to `WS_METHODS` and `WsRpcGroup`.
- Pre-existing typecheck errors in `apps/server/src/server.test.ts`, `bin.test.ts`, `SafeVaultWrite.ts` remain (T11 learnings already noted). My changes introduce 0 new typecheck errors and 0 new test failures (verified via stash + baseline run: 36 pre-existing failures in `server.test.ts` are identical with or without T9).

## Task 19 — Tag parser (`packages/shared/src/markdown/tag.ts`)

- Wikilink parser already exists at `packages/shared/src/markdown/wikilink.ts`. Tag parser mirrors its exclusion-zone shape (fenced code, inline code) but adds URL exclusion (so `https://x.com/#anchor` does not register `#anchor` as a tag). Wikilink parser excludes frontmatter; tag parser READS frontmatter as a complementary source.
- Tag rules: body must start with a letter (`[a-zA-Z]`) and continue with `[a-zA-Z0-9_/-]*` — supports `parent/child` nesting, rejects `#123`, requires non-wordish preceding character so `foo#bar` is not a tag.
- Heading detection: `(^|\n)(#{1,6})(?=[ \t]|$|\n)` — tracks each `#` position so `#abc` after a heading position is still rejected (every `#` in `### deep` is in the heading set).
- URL exclusion uses `\bhttps?:\/\/[^\s<>"')\]]+` — entire URL span excluded so the `#fragment` inside is invisible to the tag scanner.
- Inline code pairing must reject runs of mismatched length AND reject pairs that span blank lines (`/\n\s*\n/`); otherwise `` `unmatched ` ... `paragraph break` ... `#tag` `` falsely excludes the tag.
- Frontmatter input is a parsed object (not raw YAML). Caller is responsible for parsing — keeps the parser pure and dependency-free. Supports both array (`tags: [foo, bar]`) and comma-separated string (`tags: foo, bar`) forms; entries failing the `TAG_BODY_FULL` shape check are silently dropped.
- Deduplication: lowercase `Set<string>` shared between inline + frontmatter so the same tag from both sources is collapsed; first occurrence (inline-first iteration order) wins.
- Test location: spec called for `packages/shared/test/markdown/tag.test.ts` even though sibling tests are colocated in `src/`. Vitest default include picks up the new path; `tsconfig.json` `include` updated to `["src", "test"]` so `bun typecheck` covers the test file.
- Subpath export added as `"./markdown/tag"` in `packages/shared/package.json`. Wikilink parser does NOT yet have its own subpath export — out of scope for T19 to add one.
- Pre-existing typecheck/lint warnings in `wikilink.ts` (no-useless-escape, no-array-sort) and unrelated `apps/web/src/components/editor/livePreview.ts` errors confirmed pre-existing; T19 introduces 0 new typecheck errors and 0 new lint warnings.

## T13 — Wikilink Parser

- Sister module exists at `packages/shared/src/markdown/tag.ts` (T12) — same architectural pattern: pure parser, exclusion-zone detection (frontmatter, fenced code, inline code, HTML comments).
- Tests live in `packages/shared/test/markdown/` (NOT co-located in `src/`) — `tsconfig.json` was updated to `"include": ["src", "test"]` to support this structure.
- Lint gotchas in oxlint:
  - `\[` inside `[^...]` char class is an unnecessary escape — use `[^[\]...]`.
  - `\`` in template literal inside `?:` ternary is unnecessary; extracting the ternary to a const variable avoids the escape and improves readability.
  - Prefer `Array#toSorted()` over `[...arr].sort()` (no-array-sort rule).
- `parseWikilinks` rejection rules (basenames only):
  - `[^[\]|\n#^]+` for the basename naturally rejects `[[Note#H]]`, `[[Note^id]]`, `[[Note|alias]]`.
  - Transclusion `![[...]]` rejected by checking the byte before `[[` for `!` (0x21).
- `isWikilinkAt` uses inclusive-end semantics so the caret position right after `]]` still resolves to the wikilink — important for click-to-navigate (T15) and autocomplete (T14).
- Pre-existing typecheck errors in `apps/web/src/components/editor/livePreview.ts` and `MarkdownEditor.tsx` (unrelated to T13) — these are from earlier in-flight work, not introduced by this task.

## Task 12 — Live Preview decorations (CodeMirror 6)

- `syntaxTree(state).iterate(...)` invokes the callback with a `SyntaxNodeRef`, **not** a `SyntaxNode`. `firstChild` / `lastChild` / `parent` only exist on the full `SyntaxNode`, so callers must unwrap via `nodeRef.node` before walking children. TypeScript surfaces this as `Property 'firstChild' does not exist on type 'SyntaxNodeRef'`.
- `EditorView` is both a value (for `EditorView.theme(...)`) and a type. Importing it as `type EditorView` will compile in isolation but fails at the first `EditorView.theme` usage — keep it as a value import.
- `@lezer/markdown` node names map cleanly to decoration targets:
  - Headings: `ATXHeading1` … `ATXHeading6` with first child `HeaderMark` covering the leading `#`s. Hide `[node.from, headerMark.to + 1)` to swallow the trailing space.
  - Bold / italic: `StrongEmphasis` / `Emphasis`, with first/last children `EmphasisMark` (for both `**` and `*`).
  - Links: flat children `LinkMark `[`, ..., LinkMark `]`, LinkMark `(`, URL, LinkMark `)``. The first two LinkMarks are the bracket pair; everything after the closing bracket can be hidden as one range up to the last LinkMark / node end.
  - Fenced code: child `CodeText` is the body between the ``` fences; fences themselves remain visible by leaving them undecorated.
  - Bullet items: `ListItem` whose `parent.name === "BulletList"` and whose `firstChild.name === "ListMark"`. Replace `[marker.from, marker.to + 1)` to swallow `- ` / `* ` and substitute the glyph widget.
- Cursor-aware toggle: rebuild decorations on `selectionSet` (not just `docChanged` / `viewportChanged`), and compare the line number of `view.state.selection.main.from`/`to` against each candidate decoration's start line. Treating any line touched by the selection as "cursor-on" matches Obsidian's UX for multi-line selections.
- `RangeSetBuilder<Decoration>` requires strictly increasing `from` positions. Iterating the syntax tree in document order and emitting per-node decorations as we go satisfies this naturally; mixing decorations from multiple nodes that overlap must still be added in left-to-right order.
- `Decoration.replace({})` is a zero-width substitution — perfect for hiding marker characters without altering offsets. Pair with `Decoration.replace({ widget })` when the hidden text should be replaced by a styled glyph.
- Plugin ordering: `livePreviewExtensions` must come *after* `markdown()` so that `syntaxTree()` resolves to the markdown parse tree rather than a generic stub.
- Pre-existing typecheck failures (apps/server `bin.test.ts`, `server.test.ts`, `SafeVaultWrite.ts`, `031_ProjectionProjectsKind.test.ts`) are inherited from earlier tasks (T6–T11) — out of scope for T12. My changes introduce 0 new typecheck/lint errors, and `@t3tools/web` typecheck is clean.
