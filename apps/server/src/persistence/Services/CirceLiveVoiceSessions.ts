import { EnvironmentId, TrimmedNonEmptyString } from "@circe/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

type PersistenceError = PersistenceSqlError | PersistenceDecodeError;

/**
 * One durable lease for a live voice session. Local-key sessions close against
 * the provider with the node's own key; relay sessions close against the relay
 * reservation. Both routes are stored: a node restart must still be able to
 * release its own orphaned relay slot, which the relay otherwise holds until
 * its own expiry.
 */
export const CirceLiveVoiceSessionLease = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  /** Epoch milliseconds. */
  createdAt: Schema.Int,
  /** Absolute server-side ceiling, epoch milliseconds. */
  deadlineAt: Schema.Int,
  /** Which upstream owns the session id. */
  route: Schema.Literals(["local", "relay"]),
});
export type CirceLiveVoiceSessionLease = typeof CirceLiveVoiceSessionLease.Type;

export class CirceLiveVoiceSessionRepository extends Context.Service<
  CirceLiveVoiceSessionRepository,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<CirceLiveVoiceSessionLease>, PersistenceError>;
    readonly put: (lease: CirceLiveVoiceSessionLease) => Effect.Effect<void, PersistenceError>;
    /**
     * Removes the durable lease only after confirmed upstream closure. Callers
     * keep the row on a failed close so a later sweep can retry it.
     */
    readonly remove: (input: {
      readonly sessionId: string;
    }) => Effect.Effect<boolean, PersistenceError>;
  }
>()(
  "@absterrg0/circe/persistence/Services/CirceLiveVoiceSessions/CirceLiveVoiceSessionRepository",
) {}
