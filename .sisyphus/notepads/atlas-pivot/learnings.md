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

## Contracts / Tabs

- Branded ids already exist in `packages/contracts/src/baseSchemas.ts`: `ThreadId`, `ProjectId`, `CommandId`, `EventId`, `MessageId`, `TurnId`, etc.
- Reuse `ThreadId` for chat tabs and import `ProjectId`/`ThreadId` from `./baseSchemas.ts` in new tab contracts.
- Contract re-exports flow through `packages/contracts/src/index.ts`; add new schema files there so downstream imports stay stable.
