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
- Plugin ordering: `livePreviewExtensions` must come _after_ `markdown()` so that `syntaxTree()` resolves to the markdown parse tree rather than a generic stub.
- Pre-existing typecheck failures (apps/server `bin.test.ts`, `server.test.ts`, `SafeVaultWrite.ts`, `031_ProjectionProjectsKind.test.ts`) are inherited from earlier tasks (T6–T11) — out of scope for T12. My changes introduce 0 new typecheck/lint errors, and `@t3tools/web` typecheck is clean.

## T14+T15 — Wikilink autocomplete + click-to-navigate

- `@codemirror/autocomplete` v6.20.2 was NOT yet installed despite an earlier task assertion; ran `bun add @codemirror/autocomplete` from `apps/web`. The package adds tiny overhead and exposes `autocompletion` + `CompletionContext` for plugin sources with full keyboard handling out of the box.
- Wikilink autocomplete trigger: walk back from caret looking for `[[` while rejecting newlines and `]` in between. Reject `![[` (transclusion) by checking the char before the brackets.
- Completion source returns `from: bracketStart` (covers the `[[`) so `apply` can replace the entire token with `[[basename]]`. Pair with `selection: { anchor: bracketStart + insert.length }` so the caret lands after `]]`.
- Cache strategy: per-mount `BasenameCache` with `{ status, basenames, loadedAt, inFlight }` and 5s TTL. First call fetches, subsequent calls within TTL return cached basenames synchronously (returns `null` from `ensureFresh` to mean "no refetch needed"). `inFlight` deduplicates concurrent fetches.
- `vault.listEntries(projectId, "")` returns root-only entries; nested notes won't appear in autocomplete via this method. The task explicitly scoped to root entries; a recursive walk or `vault_notes`-backed query would be a follow-up.
- `vault.resolveBasename` SQL: `WHERE relative_path = ?exact OR relative_path LIKE ?suffix` with `suffix = '%/{basename}.md'` to match nested notes. Order by `mtime DESC, relative_path ASC` so most-recent collisions win deterministically.
- Server wiring: VaultIndexLive needs `SqlitePersistenceLayerLive`. `VaultIndexLayerLive = VaultIndexLive.pipe(Layer.provide(SqlitePersistenceLayerLive))` then merged into `WorkspaceLayerLive` alongside `ThreadTabPersistenceLayerLive`. Resolved error is wrapped via `Effect.orDie` because the `WsVaultResolveBasename` RPC schema declares no error type — failures here are best treated as defects (the index is local and reads cannot fail outside of programmer error).
- `wikilinkNavigate.ts` uses a single `ViewPlugin.define` for both decorations and event handling. The plugin instance is captured in a local `const plugin` so the `mousedown` handler can call `view.plugin(plugin)` to access `instance.resolutions`. CM6 does not give a `View → instance` lookup unless you hold the same `ViewPlugin` value used to construct it.
- Cmd/Ctrl-click forwards `forceNewTab: true` to the open callback; `tabs.openNoteTab` already de-duplicates by `(vaultId, relativePath)` server-side so we always end up with a single tab per note even with repeated clicks. The `forceNewTab` flag is wired through but the server tab service does not yet honor it — future refinement.
- Broken-link UX: missing notes render `cm-wikilink-broken` (red, dashed underline). On click, `window.confirm` prompts to create; on confirm we call `vault.writeNote(basename + ".md", "")` and immediately open the new tab. We do NOT call `resolveBasename` again; we directly mutate the in-memory `resolutions` map and rebuild decorations.
- DOM click → document offset: use `view.posAtDOM(wikilinkEl)` (returns the start offset of the closest text node), then re-validate via `isWikilinkAt(content, offset)` to extract the canonical span. This protects against clicks on adjacent text being mistakenly treated as wikilink clicks.
- `view.dispatch({})` (empty transaction) is the idiomatic CM6 way to force a re-render after mutating plugin-internal state (we mutate `decorations` directly then dispatch).
- Pre-existing typecheck errors at `packages/contracts/src/vault.ts:241-242` (`Schema.greaterThanOrEqualTo` / `Schema.lessThanOrEqualTo`) belong to in-flight `VaultSearchInput` work added by an unrelated task. Errors in `apps/server/src/orchestration/{Layers,Services}/VaultIndexReactor.ts`, `bin.test.ts`, `SafeVaultWrite.ts`, and the WS handlers for `vault.listTags` / `vault.notesByTag` / `vault.search` / `vault.subscribeIndexUpdates` are likewise from in-flight tasks; T14/T15 introduces zero new typecheck errors and zero new lint errors.
- Recovery note: aggressive `git stash` during a baseline-comparison check accidentally dropped changes when the working tree had simultaneous edits. Recovered via `git fsck --lost-found` → `git checkout <dangling-commit> -- <files>`. Prefer per-file diff inspection over stash-based baselines when the working tree contains both your changes and inherited in-flight changes from prior tasks.

## T18 + T22 — BacklinksPanel + VaultSearchPanel

- `vault.getBacklinks` was NOT yet wired through WS at task start despite plan inherited-wisdom note. Implementation existed in `VaultIndex.getBacklinks` (returns `ReadonlyArray<string>` of source paths) but had no contract, WS handler, or client method. Added all three: `VaultGetBacklinksInput`/`VaultBacklink`/`VaultGetBacklinksResult` in `packages/contracts/src/vault.ts`, `WsVaultGetBacklinksRpc` in `rpc.ts` (added to `WsRpcGroup`), `WS_METHODS.vaultGetBacklinks` handler in `apps/server/src/ws.ts`, and `vault.getBacklinks` + `vault.subscribeIndexUpdates` on `WsRpcClient`.
- `VaultIndex.getBacklinks` returns flat strings (source paths) — there is no snippet/surrounding-text data in the `vault_wikilinks` index. Plan asked for "snippet of surrounding text" but that would require either re-reading source notes (expensive) or extending the schema. v1 ships path-only entries; snippet enrichment is a follow-up.
- `vault.subscribeIndexUpdates` is the right invalidation channel for backlinks live refresh (per `VaultIndexUpdate` contract docstring: "Web clients use this to refresh derived panels (backlinks, tag list, search results)..."). On any update for the matching `projectId`, refetch backlinks. Cheaper than always re-running `getBacklinks` on every file event.
- `VaultSearchPanel` was already scaffolded as a call site in `apps/web/src/components/ChatView.tsx:3774-3782` with props `{open, onOpenChange, threadId, environmentId, projectId}` — this means the panel must accept context from outside, NOT derive it from store. ChatView gates the mount on `activeProject?.kind === "vault" && activeThread`, so the panel can assume valid IDs and skip its own kind guard.
- `useVaultSearchStore.open` is read in ChatView (`apps/web/src/components/ChatView.tsx:718-719`) and bound to the panel's `open`/`onOpenChange`. The CommandPalette "Search vault" command (already wired at `CommandPalette.tsx:1064-1073`) toggles the same store, so command + Cmd+Shift+F shortcut + ChatView mount form a closed loop.
- Cmd+Shift+F shortcut: implemented as a window keydown listener inside the panel (active even when panel is closed) since no entry exists in the keybindings registry yet. `event.metaKey || event.ctrlKey` covers macOS + Linux/Windows.
- `Dialog` from `~/components/ui/dialog.tsx` (Base UI) wasn't a clean fit for a search-modal-with-input — the prebuilt `DialogPopup` adds a max-w-lg layout chrome that conflicts with command-palette-style chrome. Used a plain `role="dialog" aria-modal="true"` div with manual backdrop button instead, mirroring `CommandDialogPopup` styling. This is consistent with the existing palette, which also bypasses `DialogPopup` for its own popup component.
- `useDeferredValue` + 200ms `setTimeout` debounce is the right pattern for the search input — `useDeferredValue` defers re-renders during fast typing while the timeout debounces actual RPC calls. Cancel via `requestIdRef.current` increment inside `performSearch` so out-of-order responses are ignored.
- `useLocalStorage` from the existing hook accepts an Effect `Schema.Codec`. For recent searches: `Schema.Array(Schema.String)`, key `atlas.vaultSearchRecent`, capped at 8 entries.
- `BacklinksPanel` collapse state uses `useLocalStorage` with `Schema.Boolean` and key `atlas.backlinksOpen` — same pattern as the file tree toggle (`atlas.fileTreeOpen`).
- BacklinksPanel is currently a stand-alone component — `MarkdownEditor` is not yet mounted into ChatView (see T8 learning: "TabStrip mounting into ChatView is still pending"). The panel exposes `{threadId, environmentId, projectId, relativePath}` so a future task that wires the editor into a note-tab content area can place `<BacklinksPanel ... relativePath={tab.relativePath} />` immediately below the editor.
- Server typecheck baseline is 205 errors (T17+T20+T21 partial branch); my additions bring total to 112. All current failures are pre-existing in `SafeVaultWrite.ts`, `server.ts`, `server.test.ts`, `bin.test.ts`, `VaultRename.ts`, `031_ProjectionProjectsKind.test.ts`, and the two `Stream.callback`/`Effect.acquireRelease` lines for `vaultSubscribeFileEvents` + `vaultSubscribeIndexUpdates` in `ws.ts` (lines shift when handlers are added/removed but the underlying `VaultWatcherError` not assignable to `never` is unchanged). T18+T22 introduces 0 new TS errors. Web/contracts/all-other-packages typecheck is clean.

## T16 — vault.renameNote (wikilink auto-update)

- `VaultRename` Effect service mirrors `VaultWriter` shape: `Context.Service` + `Layer.effect`. Depends on `ProjectionProjectRepository` (load vault root + kind check) and `VaultIndex` (`getBacklinks(vaultId, oldBasename)` to find files referencing the renamed note).
- Path validation reuses the same algorithm as `SafeVaultWrite`: realpath the vault root, realpath the old path, and use `realpathAncestor` (walk up missing segments) for the new path so destinations in non-existing nested dirs still resolve correctly. macOS `/private/var` containment guard is replicated.
- Wikilink rewrite is span-precise via `parseWikilinks`: filter matches where `basename === oldBasename`, then iterate spans **in reverse** (`for (let i = matches.length - 1; i >= 0; i -= 1)`) so earlier offsets remain valid while later spans are replaced. This avoids needing a second pass to recompute offsets.
- The parser already excludes wikilinks inside fenced/inline code, frontmatter, and HTML comments, so rewrite naturally skips those — no extra logic needed. `[[old|alias]]`, `[[old#heading]]`, `[[old^block]]`, and `![[old]]` (transclusion) are also excluded by the parser's basename rules, satisfying T16's MUST NOT constraints for free.
- Atomic file rename via `fs.rename(oldAbs, newAbs)` (Node), preceded by `fs.mkdir(dirname, { recursive: true })` for cross-directory renames. Uses `fs.access` to pre-check destination existence (returns `ALREADY_EXISTS`) so `fs.rename` itself doesn't silently overwrite on POSIX (rename overwrites by default — explicit pre-check is the only portable guard).
- Source rewrites go through `safeVaultWrite` to keep the path-escape sandbox intact and to inherit atomic-write semantics. `SafeVaultWriteError` is mapped to `VaultRenameError` (`PATH_ESCAPE` / `PATH_INVALID`) at the service boundary.
- `VaultIndexReactor` already auto-reindexes on watcher events (added/changed/removed/renamed), so no manual index update is needed after rename — the chokidar watcher emits change events for both the renamed file and each rewritten source, and the reactor re-runs `parseWikilinks` and updates `vault_wikilinks` rows.
- Contract additions: `VaultRenameNoteInput`, `VaultRenameNoteResult` (just `rewrittenSources: NonNegativeInt`), and `VaultRenameError` (codes: PROJECT_NOT_FOUND, KIND_MISMATCH, PATH_ESCAPE, PATH_INVALID, NOT_FOUND, ALREADY_EXISTS, RENAME_FAILED, REWRITE_FAILED).
- WS wiring: `WS_METHODS.vaultRenameNote = "vault.renameNote"` + `WsVaultRenameNoteRpc` registered in `WsRpcGroup`. ws.ts handler is one-liner via `observeRpcEffect`. Web client binding mirrors `vault.writeNote` shape.
- `Layer.mock(VaultIndex)({...})` with a `Partial<VaultIndexShape>` lets unit tests stub only `getBacklinks` while satisfying the full service interface. Same pattern as `Layer.mock(ProjectionProjectRepository)` used in `VaultReader.test.ts`.
- Tests must `Layer.provideMerge(NodeServices.layer)` because `safeVaultWrite` transitively depends on `FileSystem | Path` via `atomicWrite`. This mirrors `SafeVaultWrite.test.ts` and is necessary because `VaultRenameLive` itself doesn't list those services in its requirement signature (they're picked up at use-site via `safeVaultWrite`).
- 8 tests: rewrite all references, code-block exclusion, path traversal rejection, ALREADY_EXISTS dest, NOT_FOUND source, KIND_MISMATCH non-vault, cross-directory rename with auto-mkdir, and basename-unchanged short-circuit (no rewrite when only the directory changes).
- Pre-existing typecheck errors in `server.test.ts` (missing `VaultRename` in test contexts) are inherited — adding `VaultRename` to the WorkspaceLayerLive auto-threads through those test scopes, same pattern as prior tasks (T2/T7/T9). My new files: 0 typecheck errors, 0 lint warnings, 0 new test failures.

## T23 + T25 — Templates + Frontmatter Rendering

- `vault.listEntries({ projectId, relativeDir: ".atlas/templates" })` is the contract path for nested directory listing — `relativeDir` accepts arbitrary depth (validated by `VAULT_PATH_MAX_LENGTH = 512`); WS rejects path-escape attempts at the server boundary, so the web layer just passes the desired subdir.
- Templates first-run: when `.atlas/templates/` is missing or empty, write a single example via `vault.writeNote({ relativePath: ".atlas/templates/meeting-notes.md", content })`. `SafeVaultWrite` already mkdir-recurse-creates parent dirs, so the directory comes into existence as a side-effect of the first write — no explicit `mkdir` RPC needed.
- CommandPalette async submenu pattern: actions push views eagerly in sync code paths, but for async-fetched submenus (templates list), call `pushPaletteView(...)` only after `await` resolves. This means the palette stays in its current view briefly while the fetch runs — for templates the fetch is fast (single FS readdir) so a loading state isn't worth the extra UI complexity. If only one template exists, skip the picker and go straight to the title prompt.
- `window.prompt` is acceptable for the title input per task spec ("MUST NOT add structured GUI editor"). Returns `null` on cancel — must explicitly check, since `""` is a different (invalid) state that should toast an error.
- Title-to-relative-path sanitization: strip ASCII control chars (`\u0000-\u001F`), replace `/` and `\` with spaces (no nested directories from a single title field), collapse whitespace, strip trailing `.md` if user typed it, then re-add. Lint rule `no-control-regex` triggers on the `\u0000-\u001F` range — suppress with `// eslint-disable-next-line no-control-regex` and a justification comment because the sanitization is intentional.
- `EnvironmentId | ProjectId | ThreadId` are all in `@t3tools/contracts`. CommandPalette already imported `EnvironmentId` and `ProjectId` for the add-project flow but NOT `ThreadId` — added when wiring template flow because tab-open and template instantiation thread the `ThreadId` through.
- CM6 frontmatter detection is line-string-based, NOT lezer/markdown AST: `state.doc.line(1).text === "---"` then walk forward looking for the closing fence. Lezer-markdown has a frontmatter node only if the markdown extension is configured with `frontmatter: true` (we don't), so a manual scan is simpler and works regardless. Malformed frontmatter (no closing `---`) returns `null` → `Decoration.none`, no crash.
- Cursor-aware collapse: `StateField<boolean>` for the user's collapsed preference + `StateEffect` to flip it. The effective collapsed state is `preference && !cursorInsideRange`, so typing inside the frontmatter block auto-expands the view, but when the cursor leaves it stays expanded only if the user hadn't collapsed it. Updates trigger when the field changes (`update.startState.field(field, false) !== update.state.field(field, false)`).
- `Decoration.replace({ widget, block: true })` with a `block: true` flag substitutes the full multi-line range with a single block widget (the summary button), keeping the document offsets intact while visually replacing N lines with one. Without `block: true`, multi-line replacements display oddly in CM6.
- `WidgetType.ignoreEvent` should return `false` for the events we want CM6 to NOT handle internally. For a clickable summary button, returning `false` for `mousedown` lets our `addEventListener` run; CM6 v6 docs say `false` means "handle the event normally / don't let CM consume it".
- Plugin ordering: `frontmatterExtensions` must come BEFORE `livePreviewExtensions` in the extensions array. Otherwise livePreview's heading/emphasis decorations would try to render inside the frontmatter range, conflicting with our block-widget replacement. Frontmatter wins because it claims the entire range first.
- Pre-existing typecheck errors in `apps/server/src/{server,ws,vault/SafeVaultWrite,bin.test,server.test}.ts` are inherited (T18+T22 learning notes confirm). T23+T25 introduces 0 new errors. `bun lint` warnings in unrelated files (CommandPalette dep array, VaultReader function scoping) are pre-existing. New files (`Templates.ts`, `frontmatterDecoration.ts`) are clean. All 1050 web tests pass.

## T24 + T26 — Version History UI + Graph View

- **Pre-existing baseline:** 156 typecheck errors (mostly `apps/server/src/{server.test.ts,bin.test.ts}` "Missing X in expected Effect context" + `SafeVaultWrite.ts` `nodeBuiltinImport` + `031_ProjectionProjectsKind.test.ts` `pk` property + `ws.ts` `Stream.callback`/`Effect.acquireRelease` `VaultWatcherError` not assignable to `never`). T24+T26 introduces **0 new typecheck errors**; the only diff is union ordering and line-number shifts in pre-existing errors.
- **`runProcess` from `apps/server/src/processRunner.ts`** is the cheapest way to shell out to git when the existing `GitVcsDriver` would require provisioning the full VCS layer (which expects `cwd` repo bootstrap). Plan-19 explicitly tracks the migration via `// TODO(plan-19): migrate to VcsDriver` comments at every git call site so the future refactor has a complete grep target.
- **`runProcess` options:** `outputMode: "truncate"` for `git log` (long history may exceed default 8 MiB buffer); `allowNonZeroExit: true` for `git show` and `git commit` so we can branch on `code !== 0` without throwing (used to disambiguate "revision not found" vs "nothing to commit"). `outputMode: "error"` is the default and is correct for `git show` since we want full content but want to inspect exit code.
- **Vault git probe:** stat `vault_root/.git` before any git command to avoid noisy `not a git repository` errors. Use `isDirectory() || isFile()` because `.git` can be a file (worktree gitdir pointer) — both should count as "git is available".
- **Git log format `%H|%ai|%s`:** pipe-separated parsing avoids shell escaping. Split via `indexOf` twice (not `split("|")`) because the commit subject `%s` may contain `|` characters. Reject lines whose first field doesn't match `/^[0-9a-f]{7,64}$/i` to defend against rare format anomalies.
- **`safeVaultWrite` for revert:** the reverted file content always goes through `safeVaultWrite` so the path-escape sandbox stays intact. `git show` emits stdout with the original file body, including any trailing newline behavior that `git checkout <ref> -- <path>` would also produce.
- **Empty-revert detection:** `git commit` exits non-zero with stderr/stdout containing "nothing to commit" when the revert content matches HEAD. We surface that as `{ newCommitHash: null }` (not an error) so the UI can render "already at this revision".
- **`react-force-graph-2d` v1.29.1 setup:** install only into `apps/web` (not the root). `ForceGraph2D` ref typed as `ForceGraphMethods<NodeType, LinkType>`. `nodeCanvasObject` receives `(node, ctx, globalScale)`; meta-coords `node.x` / `node.y` are added by the simulation but absent from the typings — cast via `as { x?: number }`. `nodePointerAreaPaint` covers click hit-testing for canvas nodes.
- **Graph data shape:** server resolves wikilink `target_basename` -> `relativePath` via in-memory `Map<basename, path>` built from `vault_notes`. Unresolved targets ship with `resolved: false` so the client can render orphan endpoints in a different color. The mapping is "first basename wins" (deterministic — ordered by `relative_path ASC`).
- **`ResizeObserver` for canvas sizing:** `ForceGraph2D` requires explicit `width`/`height` props (no auto-sizing). Track container size via `useLayoutEffect` + `ResizeObserver` and pass `Math.floor(rect.width)` to avoid sub-pixel issues that make the canvas re-render every frame.
- **VersionHistoryPanel active-note resolution:** when `relativePath` prop is null (e.g., opened via command palette), the panel subscribes to `tabs.subscribeThreadState` to find the active note tab. Resolving inside the panel keeps `ChatView` free of tab-state plumbing. The subscription pattern mirrors `TabStrip`: initial `getThreadState` + ongoing `subscribeThreadState` with `onResubscribe` re-fetch on reconnect.
- **Toast manager API:** new components must use `toastManager.add(stackedThreadToast({ type, title, description }))` — there is no `toastManager.show({...})`. The `stackedThreadToast` builder accepts `type: "success" | "error" | "info" | "loading" | "warning"`.
- **`VaultIndex.getGraph` in T26:** added a new shape method `getGraph(vaultId)` returning `{ nodes, edges }`. Pure SQL (no joins), ordered by `relative_path ASC` so node iteration is deterministic. Mirrors the existing `listTags` / `notesByTag` pattern — error mapping via `toError("VaultIndex.getGraph", ...)`.
- **WorkspaceLayerLive merge:** `VaultVersionHistoryLive` requires only `ProjectionProjectRepository` (already in the layer graph via other Vault services), so registering it as `Layer.mergeAll(..., VaultVersionHistoryLayerLive, ...)` works without an explicit `Layer.provide`. The `const VaultVersionHistoryLayerLive = VaultVersionHistoryLive` indirection is kept for symmetry with the other `VaultXLayerLive` aliases.

## T30 — Marketing site rebrand (T3 Code → Atlas)

- `apps/marketing` is a tiny Astro site: 1 layout, 2 pages, 1 lib. No tailwind — vanilla CSS in `<style>` blocks.
- User-visible "T3 Code" lived in 4 files: `src/layouts/Layout.astro` (default title/description, nav alt, footer copyright), `src/pages/index.astro` (tagline, screenshot alt), `src/pages/download.astro` (Layout title/description prop, h1), `src/lib/releases.ts` (sessionStorage cache key only — `REPO` GH URL kept since the GitHub repo is not yet renamed).
- GH repo URLs (`github.com/pingdotgg/t3code`) intentionally kept in nav/footer/download buttons/releases.ts. Renaming would break `fetchLatestRelease` (the GitHub API only redirects `/releases/latest` from old slugs but the assets URLs hard-code the new slug). Repo rename is a separate ops task.
- Design choices for PKM hero:
  - Replaced "T3 Code is the best way to code with AI." (single h1) with h1 + p subtagline pair (`Atlas — A PKM writing tool with embedded AI agents.` + descriptive paragraph). Subtagline is constrained to `max-width: 56ch` for readability and fades in at 0.05s after the h1.
  - Added a `.features` section after the screenshot listing 6 PKM capabilities: Local-first vault, Wikilinks & backlinks, Tags & structure, Full-text search, Graph view, Embedded AI agents. Layout is a CSS Grid with `grid-template-columns: repeat(auto-fit, minmax(260px, 1fr))` and `gap: 1px` over a `var(--border)` background — produces a hairline-divider grid look without per-cell borders.
- Install instructions added to `download.astro` as a third section (`.package-managers`) below the platform cards: `brew install --cask atlas`, `winget install T3Tools.Atlas`, `yay -S atlas-bin`. Render as labeled code blocks (label + `<pre><code>`) with monospace styling (ui-monospace stack — keeps DM Sans for prose, code-style for commands).
- Astro check is the typecheck: `bun typecheck` runs `astro check`. Marketing has its own `tsconfig.json` (extends Astro defaults) — passed with 0 errors after changes.
- Build verification: `cd apps/marketing && bun run build` → astro static build, generates `/index.html` and `/download/index.html` in 593ms. No SSR routes.
- Footer copyright went from `© <year> T3 Tools Inc` to `© <year> Atlas` (no legal entity attached to the brand yet). If a legal entity is required for Phase 3 launch, revisit.

## T28 + T29 — Atlas Protocol + userDataDir Rebrand

- **Effect v4 vs v3 API drift:** This codebase is on `effect@4.0.0-beta.59`. `Effect.catchAllCause` and `Effect.either` are v3-only — use `Effect.catchCause` and `Effect.exit` (paired with `Exit.isFailure`/`exit.cause`) instead. The LSP's `effect(outdatedApi)` warning and `effect(anyUnknownInErrorContext)` errors both fire when v3 APIs leak into v4 code. The correct error-recovery pattern in this repo is `Effect.exit(eff)` → `Exit.isFailure(exit)` → `Cause.pretty(exit.cause)`.
- **Electron `registerSchemesAsPrivileged` accepts an array of `{ scheme, privileges }` entries**, so registering both the new (`atlas`) and legacy (`t3`) schemes in a single call costs nothing and Electron treats them identically. Both must be registered as privileged for `fetch`/`fileProtocol` to work — registering only one and "redirecting" doesn't satisfy CORS or `supportFetchAPI` for the second scheme.
- **Backward-compat scheme via shared handler:** factor the request handler into a local `Effect.fn` (typed with `request: Electron.ProtocolRequest`) and invoke it from both scheme registrations. The deprecation warning is gated by a `Ref<boolean>` so we log it exactly once per process instead of spamming on every static-asset request.
- **Effect.fn signature gotcha:** when extracting an `Effect.fn`-wrapped handler that previously inferred its parameter from inline use, you must annotate the parameter type explicitly (`request: Electron.ProtocolRequest`). Otherwise TS infers `unknown` because `Effect.fn` doesn't propagate signature info from the call site through generator yields.
- **Comment hook + necessary docstrings:** the `TODO(atlas):` removal marker on `LEGACY_DESKTOP_SCHEME` is intentional — without it the deprecated scheme would silently become permanent. The hook's priority-3 ("necessary comment") covers public-API deletion markers and security-related notes.
- **`legacyBaseDir` on DesktopEnvironment:** added as a sibling to `baseDir`, hardcoded to `path.join(homeDirectory, ".t3")` (no env var override — the legacy path is deterministic). This lets the migration service introspect the old location without reaching into NodeOS or duplicating the path-join logic. Test assertion: `assert.equal(environment.legacyBaseDir, "/Users/alice/.t3")`.
- **Migration prompt placement in startup flow:** runs in `DesktopApp.startup` AFTER `appIdentity.configure` (so the dialog uses the rebranded app name) and AFTER `electronProtocol.registerDesktopFileProtocol` but BEFORE `bootstrap` (so backend doesn't start writing into a half-migrated `~/.atlas/userdata/`). The migration service short-circuits in three cases: development mode (always skip), `~/.atlas/.migration-skipped` marker exists, or legacy `~/.t3/userdata/` doesn't exist.
- **`fileSystem.copy` in `effect/FileSystem`:** signature is `copy(source, destination, options?)` where options accepts `{ overwrite, preserveTimestamps }`. The plan asked for `fs.cp({ recursive: true })` semantics — `effect/FileSystem.copy` is recursive by default for directories. Use `overwrite: false` so a partial Atlas userdata directory isn't clobbered (we already gate on the directory being empty before prompting, so this is belt-and-suspenders).
- **MessageBox button-index conventions:** Electron returns `result.response` as the index of the clicked button (`buttons[i]`). Using named constants (`MIGRATE_BUTTON_INDEX = 0`, etc.) is clearer than magic numbers, especially when the dialog must also set `defaultId` (Enter key) and `cancelId` (Esc key) — we route Esc to "Skip for now" rather than "Don't ask again" so accidental dismissal doesn't permanently silence the prompt.
- **Failure surfacing for migration:** wrap `performCopy` in `Effect.exit`, then on `Exit.isFailure` show an error MessageBox (`type: "error"`, single OK button) AND log with `logError`. The plan's "MUST NOT silently fail migration (show error, preserve original data)" requirement is satisfied by `overwrite: false` + the explicit error dialog. The legacy `~/.t3/userdata/` is never modified.
- **Pre-existing typecheck baseline (May 2026):** `apps/server` has 100+ inherited errors in `server.test.ts` (Vault\* services missing from test contexts), `vault/SafeVaultWrite.ts` (Node fs/path imports + PlatformError leakage), `ws.ts` (`Stream.callback`/`Effect.acquireRelease` `VaultWatcherError` not assignable to `never`), `031_ProjectionProjectsKind.test.ts` (`pk` property). T28+T29 introduces **0 new errors**; desktop package typecheck is fully clean. Confirmed by `cd apps/desktop && bun run typecheck` exiting 0. All 97 desktop tests pass.
- **Test updates needed:** `DesktopEnvironment.test.ts` line 68-69 had hardcoded `com.t3tools.t3code.dev` / `t3code-dev` assertions — flipped to `com.t3tools.atlas.dev` / `atlas-dev`. `ElectronProtocol.test.ts` `registers desktop scheme privileges through a layer` test had a single-element array assertion — now a two-element array (`atlas` first, `t3` second). The `scopes registered file protocols` test continues to pass unchanged because it exercises the generic `registerFileProtocol` API with a literal `"t3"` scheme (not the desktop-specific scheme constant).
