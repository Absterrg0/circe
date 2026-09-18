# Circe build decisions

Architectural calls made while integrating upstream orchestration V2 and building
the Circe control layer. Each entry states the decision, the reason, and the
alternative that was rejected. Written so a reviewer can change any one of them
without re-deriving the context.

## Interface priority

### Desktop and mobile are the product; web is a last resort

The desktop app (orb overlay, tray, hotkey, native voice) is the primary
interface and mobile is second. They control each other and headless nodes.
The web UI exists for capability and interaction only and is never the surface
to build first. A feature that touches several clients is implemented and
verified on desktop and mobile before web, and browser-tab-only behavior gets
no design effort. Speech, hotkeys, the orb, and the tray are desktop
capabilities. Desktop and browser use execute on the target node; the origin is
the user's current device.

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

The split paths (`decisionCompose`, `toolRegistry`, `converse` carrying an
answer) are replaced by one TypeSafe classification that composes a single
`CirceOutcome`: `work`, `tool-answer`, `client-action`, `clarification`,
`conversation`, or `refused`. `converse` no longer doubles as a tool answer or a
durable thread.

### Tools declare their host and are capability-gated

`controlTools` declares each bounded tool with `host: node | client`, risk,
finite parameters, and acceptance speech. The classifier is offered only tools
whose host advertised the capability, so a Controller is never handed a node
tool it will refuse. A missing executor on the node is a wiring failure, not a
"not on this device" message.

### Bounded results are typed on the wire, and client tools are advertised

`CirceExecutionResult` carries `tool-answer` (a node tool ran; the speech is
the outcome) and `client-action` (the origin client must run the named tool
with its revalidated arguments and report the real result). The execute input
carries `clientTools` and `clientToolCandidates`, so the node offers the
classifier only actions the origin device can actually run: an unsupported
platform API is an absent capability, never a refusal. `packages/circe-client-runtime/src/circe/clientActions.ts`
is the single executor seam; web, desktop, and mobile supply platform executor
tables. App and media parameters are the exception to the code-built rule only
because their candidate sets belong to the client: the node cannot enumerate a
user's installed apps, so the client sends bounded names and the client
revalidates its own pick.

Two things are deliberately not done yet. Web and mobile still short-circuit a
project-free `open-website`/`lookup` proposal before `execute`, because a
project-free control execute does not exist; the typed `client-action` result
is therefore emitted on the proposal-first execute path but not yet the only
route. And `open-app`, `media`, `clipboard`, `notifications`, and `computer`
have executor tables but no semantic proposal action yet, so only `open-website`
and the node tools are reachable end to end.

### Typed pending for every clarification kind

Every clarification is a durable typed frame, including lookup and website
refinement, which the old system left untyped. Pending state lives on the node
and follows the user across paired clients.

### Chat is not a project

General conversation is a durable chat surface, not a synthetic `Conversations`
project. Work launched from chat references its task; the T3 thread remains the
provider's durable history for that work. Projects carry shared context that
conversations inherit. (This is the target; the current branch still carries the
old conversation-project path in V1 code and will be replaced in the rebuild.)

## Autonomous surface use

### Grounding is the constraint, not the LLM

Autonomous browser/desktop use is only fast and safe when each action targets
something the host has enumerated. The browser already has that: the
`previewAutomation` broker returns grounded `PreviewAutomationElement` records
(role, name, selector, bounds) and accepts selector-targeted operations, so the
model selects among known elements and coordinates are derived. Desktop
`DesktopUse` does not, so a desktop loop today would be an LLM inventing
coordinates. The deterministic step layer (`packages/circe-core/src/computerUse.ts`)
therefore takes a surface element catalog as its input and never lets the model
emit an element id, coordinate, key, or direction outside a supplied finite
set. Typing is the one field that cannot be closed, so the provider plan
supplies the text and the selector only chooses when and where.

### Linux desktop grounding reads AT-SPI, not pixels

`apps/server/src/circe/desktopUse/linuxAccessibility.ts` reads the OS
accessibility tree through a short embedded Python helper and maps it to the
same bounded element catalog the browser observer produces. AT-SPI is a D-Bus
protocol with no Node binding here, so the helper is embedded and run through
the desktop command runner rather than packaged as a script. The accessibility
state set is not reliable across compositors, so visible bounds are the
grounding proxy. macOS and Windows need their own observers behind the same
surface shape; the step layer does not change.

### Perception is separate from decision

The TypeSafe decision model is not multimodal, which is not a blocker because
decision and perception are different jobs. Perception produces a text catalog
(role, name, bounds, visible text); the decision model selects over it and the
host resolves the selection to a selector or coordinate. This is why a
non-multimodal model can already drive the browser. Desktop needs the same
catalog: the OS accessibility tree where available, OCR or a vision producer
where it is not. A surface with no accessibility tree, such as a GL app, is
routed to a provider that perceives and plans, but its actions still travel as
the same typed `ComputerAction` contract and pass the same policy, approval,
and executor. One action vocabulary, whichever planner produced it.

### Computer use runs on the target node with a Circe-owned scope

A request from a phone naming desktop-1 must execute on desktop-1, and the
origin interaction receives progress and the final result. The
`computer` tool stays catalogued as a client action for now, which is why it
stays unoffered; the loop belongs to the execution node. The
`previewAutomation` broker scopes every request to an MCP provider session, and
a voice or text control turn is not one, so `circeAutomationScope` builds a
Circe-owned equivalent with a synthetic session id that is stable for the
control session. Host stickiness and disconnect behavior match a provider
session. The scope grants only `preview` and `desktop-use`.

### Approval is once per session

Starting an autonomous surface session requires one confirmation. Actions
inside the session run without per-action prompts, and an explicit stop is
always available. Per-action confirmation was rejected as unusable for
multi-step goals; a risk-tiered model can be layered on later without changing
the session gate.

## Project memory

### Index and fetch, never injection

A project's memory lives on the node that owns the project. A thread never
receives the bodies. It receives a compact index (id, kind, source, title,
tags, age, and an approximate token cost) and fetches a body on demand. This
follows what Cursor and Claude Code converged on: Cursor keeps project context
as files agents read on demand, and Claude Code stopped always injecting its
memory index in favour of prefetching only what the current turn needs, under a
byte cap. Blanket injection spends context on irrelevance and buries the task;
progressive disclosure keeps the window for the work. The index is flat, not
recursive: a second routing level has been measured to hurt.

### Episodes are cheap, facts need evidence

Memory is two shapes. An episode records what happened, append-only, with
provenance and a timestamp; it is the source of truth and safe to keep. A fact
records what is true, and is promoted only on explicit user confirmation or
repeated corroboration. `system` content is never a fact source. Facts carry an
expiry and are retired on contradiction; episodes do not expire. This is why
`buildMemoryIndex` ranks facts above episodes and drops retired or expired
entries.

### The pinned layer is small and cacheable

Only identity, safety policy, a short project brief, and the memory index are
pinned into a thread. Retrieved bodies go last, after the stable prefix, so the
prompt cache survives. Memory adds a fetching round trip on purpose; a wrong or
stale injection is worse than one more tool call.

### Reverse states from day one

Every entry can be inspected and forgotten (`CirceMemoryForgetInput`), because
memory that cannot be corrected accumulates poison. Provenance is stored so a
bad source can be retracted as a unit.

## Open for review

- Whether `CIRCE_*` CI secret renaming happens in this stack or a dedicated ops
  PR. Chosen: documented now, executed with the release pipeline.
- Whether the T3-era lowercase storage keys (`t3code:themes:*`, theme id
  `t3-chat-dark`, GNOME extension UUID `snap-shot@t3.codes`) are migrated or
  left. Chosen: left, because they are persisted identities with no users yet
  but no benefit to forcing a migration.
- Whether the `@t3code/t3-<platform>` legacy npm launcher is deprecated or
  unpublished. Chosen: deprecate, because deprecation is reversible.
