# TypeSafe experiments

Spikes on `experiment/circe-typesafe-ideas`. Nothing here is wired into the
product and nothing here should be merged without a decision. The branch is
based on `feat/circe-typesafe-decision-tier`, so it reuses the real decision
seam (`decision.ts`, `decisionRequest.ts`, `decisionCompose.ts`, the
`CirceDecision` service) rather than inventing a parallel one.

## The thesis

A finite decision is not just an interpreter trick. Almost everywhere Circe
currently guesses, defaults, or asks a global on/off question, it can instead
select from a closed set of options and let code derive the result. The model
supplies the choice; code owns the consequence. That split is what makes the
behavior trustworthy enough to be aggressive: the more places we let it decide,
the more places it must not be allowed to act alone.

Each module here follows the same shape: `build*Request` (pure, closed options
and boolean predicates), `compose*` / `pick*` (pure, deterministic, and allowed
to override the model), and a test file. The rules that must never bend live in
`compose*`, not in the prompt.

## What is here

### Interpreted commands

- `desktopDecision.ts` extends the model to desktop use. Open windows are
  enumerated as Choice options, the action set is closed, and `type` refuses
  unless code extracts an explicit quoted span. No coordinates, no visual
  grounding, no model-authored text. This is the optional Phase 7 of the
  decision-tier task, prototyped in `apps/server/src/circe/desktopUse/`.

### Delivery and attention

- `deliveryDecision.ts` decides `speak | push | badge | silent` and
  `now | queue | hold` from typed attention state. Today reports speak by
  default (one global boolean in `apps/web/src/circePreferences.ts`) and push
  fires to every token (`apps/server/src/circe/push/ExpoPushNotifications.ts`),
  so a user staring at a thread still gets spoken to, and a backgrounded user
  gets buzzed for work already read. Code rules: actionable outcomes always
  reach the user; never speak while speech is active or from the background; a
  completed result focused on its own thread is silent. The typed state already
  exists in `packages/contracts/src/background.ts` (`ClientActivityLease`,
  `HostPowerSnapshot`) and `apps/server/src/background/BackgroundPolicy.ts`.
- `attentionDecision.ts` answers "what needs me right now?" over the task desk.
  There is no aggregate attention view today: the desk is a recent list ordered
  by last focus (`CirceTaskDesk.ts`), status is single-task template speech
  (`command.ts:452`), and push is one generic notification per event. Code
  ranks every task by typed state; the model picks a lead and a reason; a pick
  below the top band is overridden. The spoken line is composed from typed
  state only.

### Conversation and safety

- `bargeInDecision.ts` classifies speech that lands while Circe is working:
  `command | correction | stop | answer | backchannel | ignore`. Live voice
  currently trusts a prompt policy and a regex over the last 400 characters
  (`CirceLiveVoice.logic.ts`), so backchannels sometimes cancel work and
  corrections sometimes get dropped. Code rules: stop and correction always
  interrupt; answers route only to a waiting request; a command queues during
  speech; uncertain speech is never an interruption.
- `approvalDecision.ts` classifies a specific provider request into a closed
  risk tier and a closed grant scope. `describeApproval.ts` has no case for
  commands, so every command is `unknown`, and it trusts a provider-claimed
  tier. Code never auto-accepts destructive, external, irreversible, unknown,
  or ambiguous requests, and auto-accepts only inside a grant the user already
  gave. Risk predicates (`irreversible`, `network_or_secrets`,
  `touches_outside_workspace`) force a high floor even if the model says
  "read".
- `selfConsistency.ts` asks a high-stakes question twice and accepts only on
  agreement, turning model variance into a Clarify instead of a wrong
  dispatch. Costs two requests, so it is only for irreversible turns.

### Routing

- `modelRoutingDecision.ts` routes by stated intent instead of array order.
  Today an unnamed request takes the first usable provider and its default
  model (`command.ts:492`), effort is silently defaulted to the descriptor low
  (`modelChoice.ts:119`), and a "cheap" supervisor model is a regex over slugs
  (`controllerHelpers.ts:291`). Here the model selects a priority
  (`cheap | fast | best | default`) and a reasoning-heavy predicate, and code
  ranks the real catalog using host-supplied cost/speed/quality ranks. A named
  model always wins; missing rating data falls back to the default and says so.

## The broader opportunity map

Grounded in the survey, not yet built. Ordered by user-visible leverage.

1. **Per-provider mode mapping.** Six adapters independently map the same four
   runtime modes to native flags, and they disagree (Codex `auto` is
   `auto_review`, OpenCode `auto` still asks, Antigravity `auto` is `default`).
   A finite decision over normalized behavior ("ask for writes but not reads",
   "never touch the network") plus one mapping table would remove the drift.
   Files: `CodexSessionRuntime.ts:501`, `ClaudeAdapter.ts:4647`,
   `opencodeRuntime.ts:484`, the three ACP supports.
2. **Steer vs continue vs queue vs hold.** `continuationModeFor`
   (`command.ts:685`) returns `steer` only when the task is `running`; it
   ignores waiting states, failures, and queued follow-ups. A closed
   `follow_up_route` choice replaces the boolean.
3. **Next action for a blocked task.** `describeCirceTaskStatus`
   (`command.ts:452`) never says what to do next. A closed recommendation
   (`answer-approval | answer-question | retry-provider | send-follow-up |
open-task | do-nothing`) derived from typed state turns a dead-end string
   into guidance.
4. **Speech depth from outcome.** One fixed 460/600-char budget for every
   result. A `one-line | brief | detailed | skip` choice with predicates
   (`has_code_blocks`, `has_actionable_failure`, `same_thread_focused`) would
   make long results readable and short ones instant.
5. **Push bundling and suppression.** Notifications are unranked and
   unbundled; a backlog emits N identical buzzes. Rank with
   `attentionDecision.ts` and bundle by leading reason.
6. **Cross-node routing.** `decisionCatalogFromEvidence` drops models
   (`decisionTier.ts:153`), so a remote-proposal path cannot even represent a
   model choice. A node x provider decision over `CirceInterpretInput.nodes`
   would let "use the desktop, it has Claude" work.
7. **Guardrails on pasted content.** A Noul pass over pasted text for prompt
   injection or secret material before it reaches a provider, following the
   llm_guardrails pattern.

## Rules that keep this safe

- The model never writes identifiers, paths, commands, or speech. It selects.
- Every `compose*` re-checks the selection against typed state and may override
  it; a missing or malformed answer is a Clarify, never a default-deny or
  default-act.
- Confidence floors are non-decreasing in risk, and destructive or
  irreversible outcomes always require explicit confirmation regardless of
  model confidence.
- A decision decline (no key, timeout, rate limit) must never strand the turn:
  each integration needs a documented fallback, exactly as the interpreter
  keeps the provider proposal as its net.

## Running

`vp test run src/experiments` in `packages/circe-core` (31 tests).
