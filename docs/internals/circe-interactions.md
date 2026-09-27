# Circe interactions and operations

A voice or text turn directed at the assistant is owned by one durable
`Interaction` record on one node. Clients submit input and render state; they
never decide what an answer resumes. Device effects are owned by an
`Operation` record written before execution.

## Ownership

- The interaction owns the current goal, the pending question, its revision,
  the bound device target, and the active operation reference. It is stored in
  `circe_interactions` and read by every device that connects to the node.
- A node has at most one active interaction. Starting a new goal supersedes
  the previous active record; the old one stays inspectable by id.
- The question exists before Circe asks it. `pending` carries the kind, the
  missing slot, the known arguments, and any offered choices. A client ref is
  never the question.
- Coding and conversation goals are recorded as the interaction's goal but
  executed by the ordinary provider path. The server returns a `delegated`
  result with the grounded proposal; the client executes that exact proposal
  and does not re-classify. Checkpoint bookkeeping still never replaces a
  successful provider result.

## Revisions and acceptance

- The revision increments on every state transition. Consuming an answer is
  one transition; recording its result is another.
- A submission may carry `expectedRevision`. A mismatch returns `stale` with
  the current state. This is what stops two devices from consuming the same
  question; it is a compare-and-set in `saveState`, not a client check.
- Accepting a device operation is one transaction: the operation row, the
  request claim, and the interaction revision move together. The compare-and-set
  compares against the revision that is in storage, which differs from the
  new state's revision when an approval was just consumed; conflating the two
  makes a confirmed "yes" return stale before anything runs.
- The transaction claims the client's `requestId` with a link to the
  operation. A retry during or after a mission returns that same operation
  instead of accepting a second effect. `circe_interaction_requests` also
  makes a replayed `requestId` return the stored result; the claim is the
  ordering authority for a device effect.
- `preferredNodeId` is intent, not authority: a submission that names another
  node is refused, never executed locally.
- A restart reconciles operations left `accepted`, `running`, or `verifying`
  as `outcome-unknown`. They are never replayed, because the effect may or may
  not have landed.

## Lookups

- A weather or time request without a place arrives from the classifier as an
  `unsupported` proposal carrying a lookup clarification. The interaction
  turns that into a lookup goal with a location question, so a bare city name
  is an answer, never a new request.
- The lookup runner returns a typed outcome: an answer, a question (missing,
  ambiguous, or unavailable day), or unavailable. Place spans are the user's
  own transcript words; an offered choice wins over a fresh extraction.
- The legacy `circe.quickLookup` RPC remains for old clients only. New clients
  read and answer interaction state.

## Operations

- An operation is persisted with `accepted` status before the first physical
  action, keyed by operation id and carrying the interaction revision it was
  accepted at. A lost response is resolved by reading the operation and app
  state, not by retrying the effect.
- Statuses are `accepted`, `running`, `verifying`, `completed`, `stopped`,
  `blocked`, `needs-input`, and `outcome-unknown`. `completed` requires the
  goal-specific check; the step loop reports `unverified` when the check fails
  or when only a wait was applied.
- The desktop step loop checks cancellation before capture, after selection,
  and again immediately before the mutation. Input actions require a grounded
  element or the element the observation reported as focused; a missing
  element never falls back to ambient focus. Observation references bind an
  action to the capture it was selected against.
- The accepted target is pinned: node, surface, profile, application, and tab
  travel into the mission and the adapter uses exactly that target or refuses.
  A disconnected profile is an error, never a reason to drive whichever
  connector remains.
- Stop targets the interaction's own operation first; only a coding or
  conversation goal falls through to the node's running provider task.
  Shortcuts, launches, navigation, keyboard traversal, and recovery run under
  the same registration and the same stop gate as the loop.
- `interrupt` reports `stopRequested` and `stopConfirmed` separately.
  `stopConfirmed` follows the executor's own cleanup, never a stop flag that
  was merely set.

## Browser connector

- The extension runs in the user's Chrome profile and speaks to the node through a native
  messaging host. The node owns a local socket and token file (both 0600); the host authenticates
  with the token, and one connection is one extension instance with one profile label.
- Requests and responses are correlated by id. A pending request fails when its connector
  disconnects; nothing is applied from an unmatched result.
- The browser mission prefers the connector for the `browser` surface and falls back to desktop
  accessibility control of the browser window. The preview broker is only ever the `preview`
  surface. Element handles are `ax:<backendNodeId>` ids the extension produced; a stale handle is
  refused, never turned into a coordinate.
- Native host registration is idempotent and written to the Chromium-family browser directories on
  Linux and macOS, plus the registry key on Windows.

## Platform adapters

- macOS observation uses System Events through JXA; Windows uses PowerShell UI Automation. All
  three emit the shared `AccessibilityTree` JSON including field text and widget state, and
  re-check role, name, and (where the platform can) the owning application before an element
  action. macOS numbers processes by their position in the full process list, so an action
  resolves the same application the dump named.
- These adapters prove the command and parse contract. Autonomous native control on macOS and
  Windows still needs a real-device acceptance pass before it is advertised as capable; the
  readiness probe reports the observed tooling, not a promise.

## Planning and recovery

- Completion has a kind. An action goal is complete when its activation was
  applied; a state goal needs the named value on the surface; an artifact goal
  needs saved or created content. One generic "did the screen change?" check
  cannot decide all three. The goal check is told the kind and the observed
  change facts; a state goal may already hold before any action.
- Two consecutive applied actions that change nothing stop the loop in code
  (`no-progress`) instead of spending the remaining budget asking a model to
  repeat itself.
- Planning ahead is semantic, never id replay: one short provider plan names
  controls by role and name with a precondition and postcondition per step.
  The host resolves each step against the surface captured when it becomes
  eligible, so navigation or a dialog cannot make a plan act on stale handles.
- A step that does not resolve, or whose postcondition fails, ends the
  remainder of the plan and triggers at most one replan. A finished plan is
  checked against the surface, not against another model claim.
- Recovery plans are validated as a prefix: a step that cannot run rejects
  every later step with it, because their preconditions are unknown. Recovered
  actions run through the loop's own observation and stop gates, one per fresh
  surface.
- Planning and recovery use the node's ordinary configured supervisor through
  `TextGeneration`, so there is no Circe-only provider path. No configured
  supervisor means no plan, and the stall is reported.

## Readiness

- `circe.device.readiness` reports what the node observes: preset permission,
  adapter support, an active desktop session, permission, and per-surface
  readiness. A preset permits control; it does not prove a controllable
  session.
- Clients submit device work to a node that advertises the capability, but the
  node re-checks readiness and refuses with the observed reason. A missing
  surface never silently moves to another node.

## Live voice admission

- One committed utterance per user turn. The provider's
  `session.delegation.created` and the silence endpoint both call
  `commitUtterance`, which stamps a monotonic revision and a stable host id.
- The turn is identified by the provider's audio item (`start_ms`). A delta
  that revises the same item, including a corrected transcript, does not
  reopen admission and replaces the item's text instead of appending to it.
- The assistant speaking does not admit a request and does not finish a
  delegated one. A new user turn or session teardown ends the wait; a spoken
  backend result (`speak`) settles it.
- The `circe-client-runtime` controller is the only admission path; the web
  and mobile clients register a delegate and never re-classify the transcript.
