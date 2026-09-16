# TypeSafe experiments

Spikes on `experiment/circe-typesafe-ideas`. Nothing here is wired into the
product and nothing here should be merged without a decision. The branch is
based on `feat/circe-typesafe-decision-tier` so it can reuse the real decision
seam, request builder, and composer.

## What is here

- `desktopDecision.ts` (`desktopDecision.test.ts`) extends the finite-decision
  idea to desktop use. Open windows are enumerated as Choice options, the
  action set is closed, and a `type` action refuses unless code extracts an
  explicit quoted span. No coordinates, no visual grounding, no model-authored
  text. This is the optional Phase 7 of the decision-tier task, prototyped.
- `selfConsistency.ts` (`selfConsistency.test.ts`) asks a high-stakes question
  twice and accepts only on agreement, turning model variance into a Clarify
  instead of a wrong dispatch. Costs two requests, so it is only worth it for
  destructive turns.

## Ideas not yet built

- **Corpus-calibrated thresholds.** The risk floors are one named constant.
  Sweep them against the recorded corpus and the live model to find the
  smallest threshold that keeps destructive false positives at zero.
- **Confidence-weighted fan-out over models.** Ask one decision over two model
  pins (`jev-latest` and a frozen version) and arbitrate by agreement, so an
  alias change cannot silently move behavior.
- **Per-question confidence routing.** Act when the minimum confidence across
  must-be-correct arguments clears a high bar, clarify in the middle band, and
  fall to the provider only at the bottom. The current code has one floor per
  risk class.
- **Tool argument expansion.** The registry currently builds text-argument
  candidates with regexes. A geocoder pass before the request would let the
  model select a canonical place, with the tool still re-checking the utterance.
- **Shadow mode.** Run the decision tier and the provider proposal in parallel
  on live turns, log disagreements, and never dispatch the decision result
  until the disagreement rate is known. This needs a feature flag and a
  bounded log, not a wire change.
- **Noul-only routing.** Once a turn is classified, ask whether the composed
  command is "exactly what the user asked" and require a high probability
  before dispatch. Cheap, but the model is not a verifier; measure first.
