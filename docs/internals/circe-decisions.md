# Circe build decisions

Architectural calls made while integrating upstream orchestration V2 and building
the Circe control layer. Each entry states the decision, the reason, and the
alternative that was rejected. Written so a reviewer can change any one of them
without re-deriving the context.

## Product and naming

### Workspace scope is `@circe/*`

Every workspace package and app moved off `@t3tools`. The generic client seam
became `@circe/client` rather than `@circe/client-runtime`, because the
Circe-owned `packages/circe-client-runtime` already owns
`@circe/client-runtime`. The published server stays `@absterrg0/circe` with the
`circe` bin so install and update commands keep working.

### Hard cut on legacy identifiers, except CI secrets

There are no existing users, so `~/.t3` aliases, the old schemes, and the old
service names were dropped rather than aliased. The one exception is the
`CIRCE_*` environment variables that back CI and deployment secrets. Those were
renamed in code and the old `T3CODE_*` names removed, but the corresponding
GitHub secrets must be recreated before the next release. See
`docs/operations/circe-rename.md`.

### `~/.t3` and `~/.jarvis` are never read or written

They belong to other products. Circe state is `~/.circe`, overridden by
`CIRCE_HOME`. The rename does not migrate those directories.

## Orchestration V2 integration

### Keep upstream's V1/V2 split

Upstream's V2 owns threads, turns, runs, subagents, checkpoints, and context
transfer. It deliberately does not own project orchestration; the
`OrchestrationV2Command` union has no `project.*` commands. We matched upstream
and did not invent a V2 project command. V1 remains the project domain.

Decision: do not port projects to V2. The alternative, porting
`project.create`/`delete`/`meta.update` into V2 so the whole V1 tree could be
deleted, was rejected because it diverges from upstream for no product gain.

### Circe dispatches through `OrchestratorV2`

Mapping now in use: `message.dispatch` with `start_immediately` or
`queue_after_active`, and `deliveryIntent: "steer"` for steering;
`runtime-request.respond` for approvals and user input; `thread.create`;
`run.interrupt` against the active run resolved from `getThreadProjection`.

### Turn provenance uses command fields, not activities

V1 recorded `circe.turn.origin` through `thread.activity.append`. V2 has no such
command. Provenance now rides `createdBy` / `creationSource` on
`message.dispatch` and `thread.create`, which V2 projects onto the user message.
If durable interaction or node identity is needed later, the correct change is an
optional origin field on `message.dispatch` plus its projection, not a synthetic
activity.

### SQLite is node-only

V2 removed the `@effect/sql-sqlite-bun` branch and uses Node's `node:sqlite`
through `@t3tools/shared/nodeSqliteClient` (now `@circe/shared`). SQLite itself
was not removed. Bun is no longer a server runtime. A `BunPtyAdapter` existed
only for that path and was deleted.

### Migrations never renumber

Circe migration IDs 41-66 stay as shipped. Upstream V2's three new migrations are
registered above them as 67-69. Upstream migration files keep their own
filenames; only the registration order moved.

## Circe control layer

### One classifier, first-class outcomes

One TypeSafe request asks the `outcome` question (`work`, a bounded tool,
`conversation`, `refusal`, or `clarification`) plus the parameters that outcome
owns; the composer consults only those, so a weather ask never drags project,
task, or compound questions into the answer. The composed
`CirceOutcome` is `work`, `tool-answer`, `client-action`, `clarification`,
`conversation`, or `refused`. `converse` never doubles as a tool answer or a
durable thread; a conversation has no decision answer, so the tier declines and
the provider net speaks it.

A place is not a language pattern. Code splits the transcript into maximal runs
of non-vocabulary tokens, TypeSafe selects the run the user named, and the lookup
re-grounds that selection into the transcript. An unanswered place becomes a
typed lookup question, and the origin client answers it with the place alone
rather than re-classifying a bare city name as new work.

### Tools declare their host and are capability-gated

`controlTools` declares each bounded tool with `host: node | client`, risk,
finite parameters, and acceptance speech. The classifier is offered only tools
whose host advertised the capability, so a Controller is never handed a node
tool it will refuse. A missing executor on the node is a wiring failure, not a
"not on this device" message.

### Bounded results are typed on the wire, and client tools are advertised

`CirceExecutionResult` carries `tool-answer` (a node tool ran; the speech is the
outcome) and `client-action` (the origin client must run the named tool with its
revalidated arguments and report the real result). The execute input carries
`clientTools` and `clientToolCandidates`, so the node offers the classifier only
actions the origin device can actually run: an unsupported platform API is an
absent capability, never a refusal.
`packages/circe-client-runtime/src/circe/clientActions.ts` is the single executor
seam; web and mobile supply platform executor tables. App and media parameters
are the exception to the code-built rule only because their candidate sets belong
to the client: the node cannot enumerate a user's installed apps, so the client
sends bounded names and revalidates its own pick.

### Surface missions are TypeSafe-grounded, not model-coordinate

A surface mission runs a deterministic step loop on the target node: each step
snapshots a grounded element catalog, one TypeSafe decision selects an action
kind and an element id, and code derives the selector-targeted operation. The
model never emits a selector, coordinate, key, or JavaScript. Typing is the one
field that cannot be closed from the surface, so it has two bounded sources: a
provider plan supplies `typeText`, or the request offers every contiguous span
of the user's own goal as a closed choice and code slices the selected span
verbatim. The model never composes text. `circe.computerUse` drives the real
machine: for a web goal it first opens the grounded site in the user's own
signed-in browser and then steps that browser, and for a desktop goal it steps
the real desktop. `circe.browserUse` drives the shared in-app preview and is the
development and testing surface, never the default for an everyday web goal.
The loop uses a Circe-owned automation identity because the preview broker
scopes requests to a provider session, and a voice or text control turn is not
one. A provider can delegate a goal to the same loop through `desktop_run_goal`
or `preview_run_goal` instead of stepping with the focused interaction tools
itself.

### Typed pending for every clarification kind

Every clarification is a durable typed frame, including lookup and website
refinement, which the old system left untyped. Pending state lives on the node
and follows the user across paired clients.

A frame id is a live-frame reference, never a retry token. Every needs-input
that keeps the same frame echoes that frame's id and a fresh frame carries its
new id, so an omitted id means the frame was consumed, expired, or replaced.
Clients bind the next answer only to the id the server just reported; replaying
a dead id is rejected before interpretation, which drops the user's request.

### Chat is not a project

General conversation is a durable chat surface, not a synthetic `Conversations`
project. Work launched from chat references its task; the T3 thread remains the
provider's durable history for that work. Projects carry shared context that
conversations inherit. (This is the target; the current branch still carries the
old conversation-project path in V1 code and will be replaced in the rebuild.)

## Open for review

- Whether `CIRCE_*` CI secret renaming happens in this stack or a dedicated ops
  PR. Chosen: documented now, executed with the release pipeline.
- Whether the T3-era identifiers are aliased or removed. Chosen: removed in one
  clean cut, because there are no users and no stored state worth migrating.
  The only exceptions are the GNOME extension UUID `snap-shot@t3.codes`, which
  GNOME requires for discovery, and the xAI OAuth referrer passed to the `grok`
  CLI.
- Whether the `@t3code/t3-<platform>` legacy npm launcher is deprecated or
  unpublished. Chosen: deprecate, because deprecation is reversible.
