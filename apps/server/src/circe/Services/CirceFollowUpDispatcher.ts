import type { CommandId, ThreadId } from "@circe/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { OrchestratorV2Error } from "../../orchestration-v2/Orchestrator.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface CirceFollowUpDispatcherShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly reconcileThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly stop: (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly createdAt: string;
  }) => Effect.Effect<
    { readonly interrupted: boolean; readonly cancelledFollowUps: number },
    OrchestratorV2Error | ProjectionRepositoryError
  >;
  readonly drain: Effect.Effect<void>;
}

export class CirceFollowUpDispatcher extends Context.Service<
  CirceFollowUpDispatcher,
  CirceFollowUpDispatcherShape
>()("@absterrg0/circe/circe/Services/CirceFollowUpDispatcher") {}
