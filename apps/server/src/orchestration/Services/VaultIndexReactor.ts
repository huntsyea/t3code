import { type ProjectId, type VaultIndexUpdate, VaultWatcherError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export type VaultIndexUpdateHandler = (update: VaultIndexUpdate) => Effect.Effect<void>;

export interface VaultIndexReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  readonly drain: Effect.Effect<void>;

  readonly subscribe: (
    projectId: ProjectId,
    handler: VaultIndexUpdateHandler,
  ) => Effect.Effect<() => void, VaultWatcherError>;
}

export class VaultIndexReactor extends Context.Service<VaultIndexReactor, VaultIndexReactorShape>()(
  "t3/orchestration/Services/VaultIndexReactor",
) {}
