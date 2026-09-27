import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/** Capped exponential backoff with jitter for a long-lived event subscription. */
export const resubscribeSchedule = Schedule.exponential("1 second").pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(60))),
  ),
);

export class SubscriptionStopped extends Data.TaggedError("SubscriptionStopped")<{
  readonly cause: string;
}> {}

/**
 * Keeps a long-lived consumer of an event stream alive. A consumer is usually
 * `Stream.runForEach` over a stream with no typed failure, so a defect or a
 * hot stream that completes would end it for the life of the process and
 * silently stop whatever it drives. Any abnormal end is logged under `label`
 * and resubscribed on a capped backoff; `onResubscribe` runs before each new
 * subscription, so the consumer can reconcile from durable state what it may
 * have missed. Interruption (shutdown) ends it normally.
 */
export const withResubscribe = <A, E, R, R2 = never>(
  label: string,
  subscribe: Effect.Effect<A, E, R>,
  options: {
    readonly onResubscribe?: Effect.Effect<void, never, R2>;
    readonly schedule?: Schedule.Schedule<unknown, E | SubscriptionStopped, never, never>;
  } = {},
): Effect.Effect<never, E | SubscriptionStopped, R | R2> => {
  let attempts = 0;
  const once = Effect.suspend(() =>
    (attempts++ === 0 ? Effect.void : (options.onResubscribe ?? Effect.void)).pipe(
      Effect.andThen(subscribe),
    ),
  );
  return Effect.retry(
    once.pipe(
      Effect.catchCause((cause: Cause.Cause<E>): Effect.Effect<never, E | SubscriptionStopped> =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.andThen(
              Effect.logWarning(`${label} stopped; resubscribing`, {
                cause: Cause.pretty(cause),
              }),
              Effect.fail(new SubscriptionStopped({ cause: Cause.pretty(cause) })),
            ),
      ),
      Effect.andThen(
        Effect.fail(new SubscriptionStopped({ cause: "event stream completed normally" })),
      ),
    ),
    { schedule: options.schedule ?? resubscribeSchedule },
  );
};
