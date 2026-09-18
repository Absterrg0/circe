# Circe controller

> For maintainers. Using Circe? See [Circe](../user/circe.md).

Circe is a provider-neutral command and voice layer over the existing T3 orchestration domain. It does not introduce a manager model or bypass provider adapters. For the multi-node MVP, T3 remains the authority: each running T3 environment is one execution node, and Circe routes a request to that node's ordinary orchestration and provider services.

## Multi-node boundary

`EnvironmentId` is the stable node identity. The client does not invent a second Circe identity or copy a project's files between nodes. Web and desktop clients keep paired environments in `EnvironmentRegistry`, refresh each node independently, and combine only the presentation catalog.

The combined catalog is node-qualified:

- `ProjectRef` is `{ nodeId, projectId }`. A project ID is meaningful only in its owning environment.
- `TaskRef` is `{ executionNodeId, threadId }`. Project and provider data are read from the owning node's current T3 projection.
- Projects, providers, and task-desk entries are grouped and labeled by node. Equal project titles are candidates, not an implicit selection.
- Provider readiness is read from the target node's live provider registry. A provider that is installed or authenticated on one node is not available on another node until that node is configured independently.

The client sends the selected `ProjectRef` to the target environment. The authenticated WebSocket boundary checks that the reference belongs to its own `EnvironmentId`; a disconnected or mismatched target fails instead of falling back to another node. A continuation uses the `TaskRef`'s execution node and remote thread identity (represented on the execution input by the qualified project and exact reference thread), so the follow-up is executed by the original node and provider conversation even when the controlling client is attached to a different node. Pairing exchanges only the session credential needed to control the selected T3 environment; provider credentials remain node-local.

The MVP has no central discovery service or repository synchronization. Nodes enter the directory through explicit pairing or an existing T3 connection path, and every node keeps its own workspace and event store. Mobile joins the same mesh: it composes the shared client runtime with its paired-environment registry and sends real multi-node text and voice turns. It does not become an execution node.

## Director seam

v1 scope is deliberately narrow: `start`, `continue`/`steer` (the host picks the
mode from live task state), `stop`, `status`, `queue`, `list-projects`, and
project-free `converse`, plus provider selection on work commands and bounded
clarification. `review`, `reroute`, and focus switching stay implemented,
tested, and evaluated, but they are advanced surface: the prompt teaches them
in one line each, and anything that is not one shaped action arrives as
`unsupported`. Destructive controls carry one extra host guarantee: a proposal
for `stop` or `reroute` against a transcript that opens with don't, do not, or
never is refused without dispatch, so a misread model can never halt or move
work the user just protected. A bare discourse "no" ("No, I meant …") is a
correction and never triggers that refusal. Turn timing uses the tiny
`circe-core/timing` recorder (monotonic marks, first write wins, missing
marks read as undefined); the eval engine measures the Director span through
it, and live reports carry per-case semantic milliseconds beside it.

The Circe Director has two narrow stages. One TypeSafe System One decision call classifies the utterance into a finite tuple of selections and predicates; the host derives one `CirceSemanticProposal`: an action plus typed evidence refs (`destination`, `task`, `subject`, `excluded`, `correction`, `provider`), each citing an exact source span located in code and re-checked byte-for-byte. The proposal carries catalog names, never IDs, wording, or acknowledgements. The pure `interpretCirceCommand` validator then resolves those refs against authoritative project, task, provider, and model catalogs and produces one discriminated `CirceCommand`: start, continue, queue, stop, status, review, reroute, focus, answer a pending request, converse, or request clarification. Typed turns carry no deterministic route; voice turns attach advisory acoustic evidence from the `groundVoiceTurn` phonetic pass that never authorizes on its own. Span offsets prove the model copied text, never that its role label is right: intent accuracy stays a model property the eval corpus measures, while the host contains every structural fault.

This boundary is deliberately narrow:

- Classification is one TypeSafe System One call over a bounded state, never a provider-specific supervisor. The decision backend is swappable behind `CirceDecision`; the key is server-side. A decline (no key, timeout, 429, network) falls through to the ordinary provider proposal as a safety net and never carries more authority than a normal proposal.
- Routine commands are classified deterministically: the decision tier builds the request from the live catalog, the host locates every cited span in code, and only then does the client send `circe.execute`. The client sends `circe.interpret` with the verbatim utterance plus untrusted mesh evidence (project, task, and provider names only, never IDs) to a chosen semantic node, which returns the typed proposal with no dispatch. The client then grounds the proposal's destination or correction ref against its real bounded catalog (`resolveCirceProposalExecuteRoute`): exact span reproduction, wrapper-contains-name, pinned follow-ups stay ambient, excluded-only turns never choose a node, ambiguity parks node-qualified choices, and an unambiguous destination on a disconnected node reports unavailable with no fallback. The execution node schema-validates the proposal and revalidates every ref against its authoritative catalog before anything dispatches; direct local callers run their single local interpretation instead. No preposition, regex, or phonetic guess ever selects a node on either path. Evidence builders tolerate partial desk rows (a missing title drops the row; other fields stay optional), mirroring mobile, so a thin snapshot can never throw the interpret call off the path.
- Uniqueness needs a complete catalog (`resolveCirceRouteCoverageConfirm`, shared by web and mobile). A name-dependent route under partial coverage confirms instead of dispatching: routed destinations, same-project destinations, and mentioned ambient names all ask ("Remote is unreachable, so I can't tell if the name is unique. Use Atlas — Local?"), while name-independent turns, pinned follow-ups, excluded names (which belong to the execution veto), and malformed proposals stay on their existing paths. With no target yet, a single mentioned visible project confirms and anything else falls through to the explicit choice question.
- Full and Controller queue raw recognition envelopes until a fresh catalog is available. A near or phonetic voice match pauses the request for an explicit yes instead of guessing, and a node collision pauses with node-qualified choices.
- The classifier handles natural paraphrases, but its selections have no authority. It cannot provide internal IDs, authorize a tool, answer an approval without typed pending state, or dispatch a command. A wrong selection (for example a destination for an incidental mention) is contained: the composer only cites what it can locate, the execution node revalidates, and a mismatch asks instead of routing.
- Voice clients play a local cue before sending the semantic request. For commands that start provider work (`start`, `review`, `reroute`, `continue` as continuation),
  the host composes one acknowledgement from the accepted route, naming the accepted target (`Request accepted for <project|task>.`); `Working on it.` is used only when the catalog no longer names the target. The classifier never authors speech. Mobile keeps the immediate cue action-neutral (a haptic tick) and speaks the
  Host-owned acknowledgement after a `started` result. Deterministic clarification, status, stop, focus, and queue responses keep their own text.
- The validator accepts only refs that reproduce the source exactly, echo their own span value, and resolve against the bounded catalogs. Unknown, ambiguous, and unheard names become bounded clarification instead of guesses, naming the exact heard text. Only destination and correction refs authorize a project route; subject and excluded refs never do, and excluded names veto ambient fallback onto the ruled-out project. At most one destination-or-correction, one task, and one provider ref per turn: anything more is malformed, and two independent control commands must arrive as `unsupported`, which the host answers with needs-input so a lead fragment never dispatches. One coding task described with several steps stays a single start, continue, or steer. Nothing here promises always-correct routing: ambiguous, absent, or vetoed destinations ask or stay ambient, never guess. What dispatches is always the deterministic resolution of the original transcript (`resolveCirceInstruction` via `deleteSourceSpans`): the source minus exactly the validated destination wrapper, with every untouched character preserved byte-for-byte, or the source unchanged when no wrapper validates. Cardinality and span checks are mechanical copy proof, not intent proof: a confidently wrong but well-formed proposal is contained to clarification, never to a wrong dispatch.
- `CirceController` owns one server turn: it loads the node catalogs and compact Task Desk state, resolves the request, and adapts the result to ordinary T3 commands on the selected execution node. Providers still receive turns through their existing adapters.
- Queued follow-ups are durable rows in `circe_follow_up_queue` containing the exact thread, instruction, request metadata, position, status, and timestamps. `CirceFollowUpDispatcher` atomically claims the oldest pending row when that thread becomes ready and derives a deterministic dispatch identity from the queue ID for retry safety. Model, runtime, and interaction settings come from the fresh T3 thread. One shared dispatcher serializes queue dispatch and stop for each thread. Pending T3 turn starts also count as active work, before the provider session appears. A fixed pool of four workers coalesces duplicate wakeups; per-thread ownership is removed when its callers finish. Queue acknowledgements confirm persistence, while starts are accepted asynchronously. Retry commands reuse the persisted enqueue timestamp so their IDs and payloads remain stable across attempts.
- A waiting provider question can be answered from any voice turn: when the focused thread has no pending request and exactly one recent task does, the controller routes the reply to that task, ignoring the pin that described the focused thread. The semantic prompt names the waiting task so the model proposes a continuation instead of new work, and the answer dispatch pins the target to the asking thread. More than one waiter stays ambiguous and asks for the task by name.
- Task clarification consumes its exact frame and changes focus in one transaction. Every `needs-input` question carries its `clarificationFrameId`, echoed back on the next control call; a missing or replaced frame rejects without cancelling, answering, dispatching, or consuming a new frame, and the rejected repeat keeps its frame guard so the Host keeps rejecting instead of consuming it as fresh work. Later focus bookkeeping preserves any newer question. Provider, model, and effort clarification carries the selected values and the next typed step across web, desktop, and mobile. Input `expectedReply` is tri-state: value pins the one live request, null records an explicit nothing-waiting snapshot, absent means a legacy caller with no pin. A new `needs-input` output pin is non-null optional: present value or absent, never null. A focused ack carries optional exact `taskRef`; web and mobile pin that identity and, when it is absent, clear the thread instead of choosing a later desk entry.
- The mesh catalog belongs to the client runtime. Its subscribers receive each completed node read, targeted refresh preserves peer entries, and unread nodes keep name resolution partial. One shared `circeMeshNodeReadiness` policy reports each node as loading, ready, or unavailable with its recovery action. Ready means the catalog read finished, even with zero projects. Mobile checks retained task references against durable thread state on reconnect instead of treating the bounded recent-task list as a complete task catalog.
- Web ControlCenter text and live conversation share one command bus: a typed composer plus the GPT-Live session, which delegates utterances into the same submission queue. The console publishes an inspectable target snapshot with project, task, pending-reply pin, and availability, plus reset and cancel paths. A background desktop instruction without an explicit project stays local to the Full focused task or lone local project. Visible route highlights and spoken progress text are feedback only; the typed target plus Host validation own the route.
- One shared client command-context helper builds `contextThreadId`, `referenceThreadId`, and the pending-request answer pin from the selected project plus task. Web and mobile both use it, and mobile execute inputs reuse the turn snapshot plus request identity across retries. A stale or ambiguous pin never answers another request: closed requests and multi-request ambiguity return explicit follow-ups. Explicit selection keeps node-qualified task identity while each fresh interaction observes the current pin from that exact task's desk state through `resolveCirceLiveContextTask`: thread, execution node, and project must agree or the retained selection stands untouched, an unknown desk keeps the retained pin, and only a present explicit null clears it. Bound answers keep their frame and pin across transport retries instead of stranding or rebinding. The web submission queue retains the complete execute payload before dispatch, including unknown and empty pins; Retry resends that payload. Queue transitions publish pending, busy, clarification, and retry availability together. Waiting UI is derived from typed runtime state, never wording: `Heard: "..."` receipt (web truncates past 140 characters, mobile past 120) for a newly enqueued capture only, `Heard "...", checking...` or `Interpreting…` at dispatch, target note `(provisional, not yet accepted)`, all silent until the Host answers. Cancel is a typed runtime action: it discards waiting and failed local submissions and sends an exact-identity pre-accept cancel (`requestId` plus execution node and origin via `circeRequestAcceptanceKey`) for the in-flight interpretation. `Cancelled` means nothing dispatched and a retry after a recorded cancel stays cancelled; `already-accepted` carries the receipt-recorded thread, task, and project identity and keeps running; a mid-commit cancel waits for the receipt and reports `unknown` when the commit failed; `unknown` keeps waiting. A new capture supersedes the previous in-flight request by that same identity. Clarification cancel only sends a server cancellation when it owns an exact clarification frame. Mobile parks direct pending-request answers before dispatch and retains their task and request identity on transport failure; cancelling an answer without a server frame is local.
- Fresh text and voice turns on web and mobile run the deterministic grammar first; when it declines, one `circe.interpret` call runs, then mesh execute grounding (`resolveCirceProposalExecuteRoute` in `circe-client-runtime/circe/routeGrounding`) over the returned proposal before dispatch: a validated destination or correction routes to the owning node instead of the ambient target, and the utterance itself is never rewritten. A pinned follow-up (an active task thread) keeps its task even when the wording names another project. Ambiguity parks node-qualified choices instead of guessing; an unambiguous destination on a disconnected node reports unavailable with no fallback to the ambient target. Excluded-only and subject-only proposals stay ambient for the execution node to clarify authoritatively. Clarification answers and bound retries never re-route and reuse the original proposal with no second inference. While a turn waits, no utterance is chosen as the command: the waiting receipt and provisional note are display only.
- Mobile pins its explicit project selection across catalog outage or removal: `resolveMobileCirceProject` returns `undefined` for a missing explicit selection, with no activity or report fallback even on first use (a lone project still resolves as the first-use default). The provider retains the key until the user explicitly reselects and exposes it as `unavailableProjectKey`, which the route screen renders with a project selector and reconnect action. `resolveMobileCirceInstructionRoute` takes an `ambientUnavailable` boolean for that pin, derived from a retained key or persisted preference without waiting on either: unqualified follow-ups return typed `unavailable` instead of borrowing ambient, singleton, conversation, report, activity, or catalog-order targets (including on an empty catalog), while an explicit project phrase still selects a healthy node. Retained focus is tri-state: `undefined` restores once from the server durable focus on the same node and project only, an explicit project-only `null` is never overridden. First-use singleton and conversation shortcuts apply only when truly no prior selection exists. Without a classified action only a bare allow or deny verdict can answer, and only a single approval pending; explicit stop, status, queue, review, reroute, focus, conversation, and new-task intents are never captured as answers and keep their ordinary policy.
- Approval presentation is an adapter over typed approval data. It keeps the exact command for visual review while speech receives a conservative risk explanation.

The decision tier talks only to the TypeSafe System One endpoint; the API key is server-side and never reaches a client bundle. The provider proposal path kept as the decline safety net uses the selected provider instance's ordinary schema-constrained text-generation capability, so Circe still has no private provider execution path. `ServerSettings.circeSupervisorModelSelection` is the last resort in that order, and the selector for project-free `converse`; it never overrides an explicit per-turn or node-default choice. Each provider proposal runs in a new empty temporary directory that is removed afterward. Codex and Claude disable their execution, MCP, and customization surfaces; OpenCode denies all permissions. An adapter that cannot guarantee a tool-free structured session, currently Cursor and Grok ACP, refuses that generation. The fallback therefore receives only the semantic prompt and schema and never runs with access to the selected project's repository or tools.

### Shared proposal contract

`packages/contracts/src/circe.ts` owns the wire shape. `packages/circe-core/src/semanticEvidence.ts` owns the matching host shape. Both define the same `CirceSemanticProposal`: one action, typed evidence refs, nullable model and effort names, and a nullable converse answer. Keep the two in sync. The wire copy stays dependency free so generic transport never imports `circe-core`.

Refs cite exact UTF-16 spans into `CirceVerbatimUtterance`. Validation requires `source.slice(start, end) === text` byte for byte, with no trim. Offsets are UTF-16 code units because JS string indexing is UTF-16. Only destination and correction can name the project route. Subject and excluded refs never authorize. At most one destination or correction, one task, and one provider ref per turn. Anything more is malformed and becomes `unsupported`, which the host answers with needs-input.

`circe.interpret` takes the verbatim utterance plus untrusted mesh evidence (project, task, and provider names only, never IDs) and returns one proposal with no dispatch. `circe.execute` carries that nonauthoritative proposal plus the verbatim source. The execution node schema-validates the proposal and revalidates every ref against its authoritative catalog before anything dispatches. Direct local callers skip the mesh step and run their single local interpretation instead.

### System One decision tier

The classifier is one TypeSafe System One request: `POST /v1/systemone` with a
structured state and a map of finite questions. The model selects an element of
a supplied set or evaluates a boolean predicate. It never produces spans, IDs,
free text, sequences, or numbers outside a set; those are derived in code.
`apps/server/src/circe/Services/CirceDecision.ts` is the swappable seam and
`Layers/CirceDecision.ts` the only outbound call: one request, 16k state cap,
1500ms timeout, one retry on 429/529/network, then a typed decline that never
fails the turn. Config is opt-in by `CIRCE_TYPESAFE_API_KEY` (or
`CIRCE_TYPESAFE_ENABLED`). `CIRCE_TYPESAFE_MODEL` pins `jev-latest` by default,
and the resolved `response.model` is recorded per turn because aliases move. The
key is server-side only and is referenced solely in `apps/server/src/cli/config.ts`.

`packages/circe-core/src/decisionRequest.ts` builds the request. Option keys are
human-readable catalog names; internal IDs never cross. `action`,
`destination_project`, `task`, `provider`, `model`, `effort`, and `tool` are
Choices over their closed catalogs plus `none`; `destination_negated`,
`is_compound`, `boundary_<i>`, `needs_clarification`, and
`contains_approval_verdict` are Nouls; `response_strategy` selects among `act`,
`tool`, `status_report`, `list_report`, `conversation_thread`, and `refuse`.
This module also owns the utterance tokenizer, candidate-boundary enumeration,
the partition law, exact name and wrapper location, and the risk thresholds.

`packages/circe-core/src/decisionCompose.ts` derives the proposal. Every span is
located in code and must reproduce the source byte for byte; a selection that
cannot be located asks instead of generating. Only destination or correction
maps to a route, and a negated target is cited `excluded` so it can never
authorize. An approval verdict becomes a `continue` so only typed pending state
can grant it. Confidence floors are non-decreasing in risk (read-only 0.6,
mutating 0.7, destructive 0.8); below the floor is Clarify, never dispatch.

`packages/circe-core/src/toolRegistry.ts` is the deterministic tool layer
(weather, time, open-website, task-status, list-projects). Enum parameters map
to a Choice, booleans to a Noul, and text parameters to code-built candidates
that the tool re-checks against the utterance. Weather and local time need no
model at all.

Compound detection and location are separate and both finite. Boundaries are
enumerated at `then`, `and then`, `also`, `after that`, `afterwards`, `next`,
`and`, and `, ; .`; one Noul per candidate decides whether a new command begins
there; the partition law (contiguous, non-overlapping, cover the command text,
at most four segments) turns the survivors into segments. Two or more segments
trigger a second request with per-segment questions (`seg<i>_action`, …), because
per-segment questions cannot be written before the boundaries exist.

`apps/server/src/circe/decisionTier.ts` adapts host state and catalogs, runs one
or two requests, and composes. `CirceController` order is prepare, decision,
compose, Director. A composed proposal runs. A composed needs-input is a
deliberate Clarify and never falls through. A decline (disabled, unconfigured,
timeout, 429, or network) reaches the ordinary provider proposal as a safety
net; the shared Director still owns all authority.

Invariants, each pinned by test: finite co-domain (every answer is a member of a
supplied non-empty closed set); locate totality (an unlocatable selection
rejects classification); the partition law; determinism of derivation (the same
decision plus utterance yields the same command, instruction, segments, and
speech); authority and negation veto; and monotone safety. The offline
derivation corpus (`apps/server/scripts/decisionCorpus.test.ts`) reproduces the
expected command for every scored dev case with zero exclusion dispatches.
Fallback is proven for no key, disabled, 429, and timeout in
`apps/server/src/circe/decisionTier.test.ts`. Live model accuracy needs the
TypeSafe key and is not measured in-repo.

The earlier bounded grammar and the four subscription supervisor tiers
(Codex, OpenCode, Grok, fx) plus the INT8 extraction tier were removed once the
decision tier replaced them. The ordinary provider proposal path remains only
as the decline safety net; open-domain conversation stays a durable provider
thread through the Director's `flow: "conversation"`.

#### Managed decision tier over the relay

The decision tier is managed by default. `Layers/CirceDecision.ts` resolves a
path in order: an explicit `CIRCE_TYPESAFE_ENABLED=false` disables the tier
entirely; a local `CIRCE_TYPESAFE_API_KEY` is used when present; otherwise a
node linked to Circe Mesh sends the same System One request to
`POST /v1/environments/:environmentId/typesafe/systemone`. The relay holds the
deployment key (`TYPESAFE_API_KEY`) and calls TypeSafe; the node never sees the
key and the relay never interprets the decision. An unset `enabled` is the
managed default, and `true` requires a path and otherwise declines as
unconfigured.

The relay is a pass-through and must stay one. Request and response bodies cross
it in memory only:

- no database, KV, queue, or filesystem write on the decision path; the only
  persistence is the per-environment usage row, which stores an id, the
  environment id, and a timestamp, never the body;
- no request or response body in logs or OTLP span attributes; only method,
  route, status, and timing are observable;
- the `Authorization` header is never logged;
- the upstream response is decoded into `RelayTypeSafeDecisionResponse` before
  returning, so unexpected top-level upstream fields never reach the node.
  `answers` stays opaque and is parsed by the node.

The route also enforces what the operator pays for: it requires the environment
link to be enabled, applies the node's own bounds (16k state characters, 64
questions) at the relay, and counts each decision against a rolling 24-hour
per-environment quota of 1000. Over-quota returns a 429, and an overloaded
upstream passes through as a 429 so the node's retry applies.

This is the whole reason the managed path is acceptable: users can say anything
and the operator cannot later read it. The relay persists agent-activity state
for notifications, so the decision route is deliberately kept out of every
persistence service. `infra/relay/src/decision/TypeSafeUpstream.test.ts` runs
the upstream with only an `HttpClient` in its requirements, which is the
mechanical proof that no persistence service is involved; `TypeSafeUsage.test.ts`
covers the quota boundary.

Exact task focus and named-task resolution are specified separately in [Circe task desk](./circe-task-desk.md). The desk keeps only qualified recent identity and one pending interaction; T3 supplies live task state.

## Request path

1. A Full or Controller client sends `circe.interpret` with the verbatim utterance plus untrusted mesh evidence to a chosen semantic node, which runs one decision-tier inference and returns a `CirceSemanticProposal` with no dispatch. The client grounds the proposal against its real catalog, then sends `circe.execute` over the authenticated WebSocket RPC boundary with a node-qualified `ProjectRef`, an optional exact reference/context thread, request metadata, the verbatim source, and the nonauthoritative proposal. Ambiguity—including equal names on different nodes—becomes a clarification with labeled candidates before any execution node is chosen. The server rejects an ambiguous unscoped request instead of guessing from visible or recent UI activity.
2. The execution node schema-validates the proposal and `interpretCirceCommand` deterministically validates project, task, provider, model, effort, pending approval/input state, and continuation authority against that node. A client may instead provide a saved `ModelSelection`; the server revalidates it against that same node. It never substitutes a provider from a different node or accepts a model-invented ID.
3. Before executing a task-control proposal, `CirceController` reloads the exact selected thread from the authoritative projection. Steering, queueing, stopping, status, and rerouting use that fresh thread's identity, state, model, runtime mode, and interaction mode. If the task disappeared or changed state while the interpretation was in flight, execution reports the fresh condition instead of acting on the semantic snapshot. In particular, a `continue` planned as a new turn against stale snapshot state steers instead when the live thread is running, so direction joins the live turn rather than opening a second one beside it.
4. `CirceController` emits ordinary orchestration commands on the execution node. New work uses `thread.turn.start`; questions and approvals use the existing response commands. Steering, queueing, interruption, and continuation use the exact node-qualified task reference; rerouting creates a new thread in the newly resolved project and node. Clarification is stored in the session's Task Desk state.
5. Cross-provider reviews create an ordinary target-provider thread on the selected node and append reciprocal `circe.review.*` activities so the relationship is durable and inspectable.

Unknown or unavailable selections return structured clarification. There is no silent provider or model fallback.

### Node-owned default agent

`ServerSettings.circeDefaultModelSelection` is a nullable, atomically replaced model selection.
The control center reads and updates it through the selected environment's existing config and
settings commands, never through primary-environment settings. No additional mesh protocol or
provider-specific dispatch path is needed.

For new tasks, selection precedence is explicit request selection, explicit
spoken provider/model, node Circe default, then the project's ordinary default. The Director's
existing clarification behavior applies when none resolves. Defaults are passed as
`fallbackModelSelection`, separately from authoritative `modelSelection`, so a project preference
cannot suppress a spoken provider choice. Continuations, queued work, and reroutes preserve their
existing task's selection. A configured but unavailable selection is an error to explain, not
permission to choose a different agent.

The web/desktop control center projects live registered connections alongside the asynchronously
loaded mesh catalog. It marks the desktop primary environment as this device, but never labels a
browser's remote primary environment as the user's device. Connection membership/status changes
refresh catalogs without polling, and stale refresh responses cannot overwrite newer results.

For routed work, the client supplies a stable `requestId` plus optional origin node and interaction identity. The server derives command and event identifiers from an authenticated acceptance key and persists the request metadata in the task-created activity. T3's command receipts and event metadata are the authoritative deduplication record: retrying the same request reuses the receipt-backed command identifiers, while reusing a request ID with a different payload returns a conflict instead of creating a second task. This is idempotency at the command/event boundary, not a task name that callers may reuse for unrelated work.

Pre-accept cancellation addresses that same acceptance key (`requestId` plus execution node and origin; sessions are excluded because reconnects change them). `trackPreAccept` runs one interpretation per key under a per-call owner lease; a cancel that lands first aborts it and reports `cancelled` with no dispatch, ever. `beginCommit` is the single atomic gate before any command is invoked and proceeds exactly once per key for the owner lease only. `finishCommit` records the typed receipt identity only after a dispatch succeeds. A cancel that lands mid-commit waits for that receipt and reports `already-accepted` with the exact identity, or `unknown` when the commit failed. Success is never claimed pre-receipt. Turns that settle without dispatching, and failed commits, leave no acceptance record, so a later cancel answers `unknown` instead of claiming work that never ran. Inputs without request metadata stay untracked and always answer `unknown`. A retry after a recorded cancel never runs again; a retry after a recorded acceptance runs untracked under the existing idempotency and conflict rules. Concurrent duplicates with the same key join the owner's in-flight result: one inference, one dispatch, every waiter sharing the exact final receipt, while a changed payload on the same key conflicts instead of sharing. Only the owner lease may begin, finish, or close a slot, so a refused duplicate can never remove the original's tracking. The settled store is bounded (128 entries); evicted keys answer `unknown`. Cancel never reaches provider internals and never stops work after acceptance; `stop` interrupts the running turn and its queued follow-ups.

General questions take one of two paths. With a project in scope, the question runs as a durable conversation thread: the start command carries `flow: "conversation"`, the thread title is prefixed `Conversation:`, and the provider answers with its tools. The thread is an ordinary T3 thread, so it stays visible in the sidebar and its completed turn speaks through the report lane. Without a project in scope, the decision tier selects `conversation_thread` and the provider answers through the normal conversation flow, so no thread, task, or receipt is created on the local path. The server exposes that project-free path as a `converse` operation that accepts optional request identity so an explicit cancel addresses the same tracked interpretation; untracked legacy calls answer `unknown`. A retry re-asks the model rather than replaying stored output.

## Presentation path

T3 orchestration state is the durable truth for a task's result, pending approval, and pending user
input. Circe adds no parallel report or completion state. Provider ingestion appends the generic
`provider.turn.result-finalized` activity after the provider has finalized the turn; approval and
user-input requests use the existing typed T3 activities; runtime failures use the existing session
and activity events. One pure classifier in `circe-core` decides which activities carry user-facing state; live presentation and push both consume it. Checkpoint capture and revert failures never produce speech. The thread projection remains complete and visible even when speech is disabled,
fails, or the client is absent.

The authoritative node exposes one live `circe.subscribePresentation` WebSocket stream. The client
supplies its origin interaction identity (and, when available, origin node identity); the server
projects only Circe-owned task events into a minimal `CircePresentationEvent` for completed, failed,
approval-needed, or waiting-for-input states. It filters by the exact origin and never routes a
presentation to another controller. Subscriptions start at connection time and do not replay old
orchestration events, so a disconnected controller receives no stale speech after reconnect. The
ordinary T3 task desk and thread UI expose the durable result or blocker on reconnect.

Presentation is ephemeral. The connected Full or Controller client keeps a small in-memory bounded
dedupe set and sends events to its local FIFO/cancel speech path. Native speech queues are legitimate adapters. Mobile presents through text and push notifications. The browser command fallback shares the reporter's `enqueueBrowserSpeech` lane so stale utterances drop instead of playing late. The command runtime owns its interaction utterances through `createCirceInteractionSpeech`: speaking supersedes the previous utterance, and cancellation, a new submission, a new capture taking the floor, or disposal retracts the retained delivery identity through the shared lane without touching provider work. Console cancel authority comes from typed pending runtime state, never from feedback wording. There is no report inbox or outbox,
cursor, batch acknowledgement, claim, confirmation, release, speaker election, lease, or delivery
retry state. Expo push tickets confirm acceptance, not delivery. Only a structured `DeviceNotRegistered` code invalidates a registration, through a conditional snapshot delete that keeps a same-token renewal. A speech failure may surface a toast, but it never changes or acknowledges the T3 task
state. Headless nodes execute and persist T3 state but do not mount voice presentation.

## Performance boundaries

- The UI host is small; the dialog is dynamically imported.
- Disabled voice clients do not subscribe to the presentation stream.
- Speech exists only inside an explicit live conversation session.
- The user can interrupt current playback without changing T3 task state.
- Live presentation reuses the authenticated WebSocket and Circe Mesh transport; it starts at connection time and does not poll or replay durable history.
- No new provider-specific logic exists; adapters continue to receive normal orchestration commands.

The Circe wire contracts live in `packages/contracts/src/circe.ts`; the server boundary is
`apps/server/src/circe/` and the WebSocket handlers. Generic snapshots, thread detail, and
dispatch remain available through `apps/server/src/orchestration/http.ts`.
