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
 * Node-local, project-owned memory. Memory is kept as workspace files under
 * `.circe/`, so the provider reads bodies on demand with its ordinary file
 * tools and the project's `AGENTS.md` carries the pinned map. Policy (what is
 * eligible for the index, when a claim may become a fact) lives in
 * `@circe/core/projectMemory`; this service only reads and writes the files.
 */
export class CirceMemoryPromotionError extends Schema.TaggedError<CirceMemoryPromotionError>()(
  "CirceMemoryPromotionError",
  { projectId: ProjectId, title: Schema.String },
) {
  override get message(): string {
    return `"${this.title}" needs explicit confirmation or corroboration before it becomes a fact.`;
  }
}

/** A memory file could not be resolved or written. */
export class CirceMemoryStoreError extends Schema.TaggedError<CirceMemoryStoreError>()(
  "CirceMemoryStoreError",
  {
    projectId: ProjectId,
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Project memory could not ${this.operation}.`;
  }
}

export interface CirceProjectMemoryShape {
  /** Append an episode or promote a fact; rejects an unsupported promotion. */
  readonly remember: (
    input: CirceMemoryUpsertInput,
  ) => Effect.Effect<CirceMemoryEntry, CirceMemoryPromotionError | CirceMemoryStoreError>;
  readonly list: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<CirceMemoryEntry>, CirceMemoryStoreError>;
  readonly get: (
    projectId: ProjectId,
    entryId: string,
  ) => Effect.Effect<CirceMemoryEntry | null, CirceMemoryStoreError>;
  /** The compact map a thread sees unprompted. */
  readonly index: (projectId: ProjectId) => Effect.Effect<CirceMemoryIndex, CirceMemoryStoreError>;
  /** Move an entry to the retired folder; provenance is never destroyed. */
  readonly forget: (
    input: CirceMemoryForgetInput,
  ) => Effect.Effect<CirceMemoryForgetResult, CirceMemoryStoreError>;
}

export class CirceProjectMemory extends Context.Service<
  CirceProjectMemory,
  CirceProjectMemoryShape
>()("@absterrg0/circe/circe/Services/CirceProjectMemory") {}
