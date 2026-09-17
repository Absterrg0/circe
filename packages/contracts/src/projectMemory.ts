import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Project memory, node-local and project-owned. Two record shapes:
 *
 * - episode: what happened, append-only, with provenance and a timestamp. Cheap
 *   to write, safe to keep, the source of truth.
 * - fact: what is true, distilled from episodes. Promoted only on corroboration
 *   or explicit confirmation, with a source and an expiry, because a fact is
 *   asserted as currently true every time it is read.
 *
 * A thread never receives the bodies. It receives a compact index (title, kind,
 * source, age, token cost) and fetches a body on demand, so memory compounds
 * without spending context on irrelevance.
 */

export const CirceMemoryKind = Schema.Literals(["episode", "fact"]);
export type CirceMemoryKind = typeof CirceMemoryKind.Type;

/** Provenance decides promotion: untrusted content is never a fact source. */
export const CirceMemorySource = Schema.Literals(["user", "agent", "system"]);
export type CirceMemorySource = typeof CirceMemorySource.Type;

export const CirceMemoryStatus = Schema.Literals(["active", "retired"]);
export type CirceMemoryStatus = typeof CirceMemoryStatus.Type;

export const CirceMemoryEntry = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  projectId: ProjectId,
  kind: CirceMemoryKind,
  source: CirceMemorySource,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  body: Schema.String.check(Schema.isMaxLength(8_000)),
  tags: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  /** Times the same claim has been seen; promotion needs more than one. */
  corroborationCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  status: CirceMemoryStatus,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  /** Facts expire; episodes do not. Absent means no expiry. */
  expiresAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
});
export type CirceMemoryEntry = typeof CirceMemoryEntry.Type;

/** The only memory payload a thread sees unprompted. */
export const CirceMemoryIndexEntry = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  kind: CirceMemoryKind,
  source: CirceMemorySource,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  tags: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  updatedAt: Schema.DateTimeUtcFromString,
  /** Rough body cost, so the model can decide whether a fetch is worth it. */
  tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type CirceMemoryIndexEntry = typeof CirceMemoryIndexEntry.Type;

export const CirceMemoryIndex = Schema.Struct({
  projectId: ProjectId,
  entries: Schema.Array(CirceMemoryIndexEntry),
  totalTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type CirceMemoryIndex = typeof CirceMemoryIndex.Type;

export const CirceMemoryUpsertInput = Schema.Struct({
  projectId: ProjectId,
  kind: CirceMemoryKind,
  source: CirceMemorySource,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  body: Schema.String.check(Schema.isMaxLength(8_000)),
  tags: Schema.optional(Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(64)))),
  /** True only when the user explicitly asked to remember this. */
  confirmed: Schema.optional(Schema.Boolean),
  /** Episode this fact was distilled from, when known. */
  derivedFrom: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type CirceMemoryUpsertInput = typeof CirceMemoryUpsertInput.Type;

export const CirceMemoryForgetInput = Schema.Struct({
  projectId: ProjectId,
  entryId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type CirceMemoryForgetInput = typeof CirceMemoryForgetInput.Type;

export const CirceMemoryForgetResult = Schema.Struct({
  forgotten: Schema.Boolean,
});
export type CirceMemoryForgetResult = typeof CirceMemoryForgetResult.Type;
