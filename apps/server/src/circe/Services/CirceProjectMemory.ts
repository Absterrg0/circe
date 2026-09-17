import {
  ProjectId,
  type CirceMemoryEntry,
  type CirceMemoryForgetInput,
  type CirceMemoryForgetResult,
  type CirceMemoryIndex,
  type CirceMemoryUpsertInput,
} from "@circe/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Node-local, project-owned memory. The store owns persistence; policy (what is
 * eligible for the index, when a claim may become a fact) lives in
 * `@circe/core/projectMemory`. A thread reads the index and fetches bodies, so
 * memory compounds without spending context on irrelevance.
 */
export class CirceMemoryPromotionError extends Schema.TaggedError<CirceMemoryPromotionError>()(
  "CirceMemoryPromotionError",
  { projectId: ProjectId, title: Schema.String },
) {
  override get message(): string {
    return `"${this.title}" needs explicit confirmation or corroboration before it becomes a fact.`;
  }
}

export interface CirceProjectMemoryShape {
  /** Append an episode or promote a fact; rejects an unsupported promotion. */
  readonly remember: (
    input: CirceMemoryUpsertInput,
  ) => Effect.Effect<CirceMemoryEntry, CirceMemoryPromotionError>;
  readonly list: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<CirceMemoryEntry>>;
  readonly get: (projectId: ProjectId, entryId: string) => Effect.Effect<CirceMemoryEntry | null>;
  /** The compact map a thread sees unprompted. */
  readonly index: (projectId: ProjectId) => Effect.Effect<CirceMemoryIndex>;
  /** Soft-retire an entry; provenance is never destroyed. */
  readonly forget: (input: CirceMemoryForgetInput) => Effect.Effect<CirceMemoryForgetResult>;
}

export class CirceProjectMemory extends Context.Service<
  CirceProjectMemory,
  CirceProjectMemoryShape
>()("@absterrg0/circe/circe/Services/CirceProjectMemory") {}
