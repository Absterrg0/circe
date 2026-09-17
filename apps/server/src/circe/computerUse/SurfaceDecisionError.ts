import * as Schema from "effect/Schema";

/**
 * The step selector could not answer: the decision tier is disabled,
 * unconfigured, timed out, or declined. This is distinct from a low-confidence
 * selection, because the loop never got a selection at all and must not claim
 * the model was unsure about a page it could not read.
 */
export class SurfaceDecisionUnavailableError extends Schema.TaggedError<SurfaceDecisionUnavailableError>()(
  "SurfaceDecisionUnavailableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `The step model is unavailable (${this.reason}).`;
  }
}
