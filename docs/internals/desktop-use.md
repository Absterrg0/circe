# Computer use

Computer use acts on the target node's own desktop through Cua Driver. The only execution path is
the in-process SDK, started with `CuaDriver.create` in Electron's main process. The server never
starts an OS input helper or calls Cua directly. Full and Controller can host computer use;
Headless cannot.

Circe pins the JavaScript SDK `@trycua/cua-driver` to 0.30.4. Visual grounding requires native SDK
libraries from the `Absterrg0/cua` distribution release, built with that fork's publisher trust root.
Circe installs the fork native packages and bundles signed catalogs for Linux x64, Windows x64,
and macOS arm64. Other supported architectures retain native accessibility with an explicit
visual-grounding limitation. The [release runbook](../operations/release.md#cua-perception-distribution)
describes how to ship the distribution.

## Authority and lifetime

The desktop host owns the runtime, OS session, permissions, and input lifetime. The server owns
consent, mission admission, cancellation, and audit. They communicate over a private local socket
or Windows named pipe authenticated by the capability in the desktop bootstrap envelope. The host
binds session-aware calls to the mission's driver session and serializes admitted calls.

Host status separates runtime state, driver-reported permissions, and capability flags.
`available` means a call can be attempted, not that an input route or permission was proven.
A graphical-session environment variable alone proves neither.

`CirceComputerAccess` owns one waiting request and one holder for the node. Circe goals, the
Computer card, and coding agents all use this owner. A changed goal needs its own approval. A
spoken answer belongs to the device session that was asked; a typed decision names the exact
request and can come from any connected device. Reconnecting clients inspect the same typed state.

A provider grant belongs to the exact thread, provider session, and running turn that asked.
`computer_begin` requests approval; it grants no authority by itself. A later run must ask again.
Run end, `computer_end`, user Stop, and native mission end release the grant. Stop, mission end,
and connection loss revoke queued work and abort in-flight calls. A later observation does not
resume a revoked mission. Teardown drains dispatched work and closes the mission's driver session.

## Whole goals

A whole desktop goal runs in circe-core's executor (`runDesktopGoal`, private `@absterrg0/circe-core`
0.4 and later). Voice, the Circe control center, and the Computer card reach it through
`CirceComputerAccess` and `CirceComputerUse.run`, which begins its own mission. A chat provider
reaches it through `computer_do`, which asks for the computer like `computer_begin` and then runs
the goal with `CirceComputerUse.runInMission` inside the run's granted mission. It never begins a
second mission. `apps/server/src/circe/computerUse/coreDesktopHost.ts` is the whole OS surface
circe-core sees. Pids, window ids, element tokens, and capture points stay behind its opaque ids.
`fill` replaces the field through the driver's guarded `set_value` mutation; `type_text` appends
and must not implement a fill. Completion is checked from a new observation, independently of
the delivery receipt and the planner's expected value. Final `computer_do` results are retained
for the granted mission so a provider retry cannot execute the goal again.

A node without circe-core 0.4 keeps the older step loop for its own missions, and `computer_do`
reports `unavailable` so providers use the step tools.

Three parties share the work, and none can do another's job:

- The planner is the node's supervisor model through ordinary `generateStructured`. It proposes
  typed steps (launch, click, fill, select, press, scroll, inspect). Each step names its control
  by role and name, never by id, and states the result the window should show. A provider may
  pass its own plan to `computer_do`, which saves that call. The planner is asked again only when
  a target is missing, Jev asks for a replan, an expected result does not appear, or the plan ends
  without the goal done. A goal gets at most three plans.
- Code grounds each step against a fresh observation. It filters to controls the verb may act on:
  only a native field takes text, and window frames are never targets. It then ranks those
  controls against the description. A field labeled only with its own content, as GTK labels an
  entry, counts as unnamed. It stays a weak candidate for a planner that guessed a name.
- Jev chooses among at most eight candidates, plus reobserve and replan, and chooses the app when
  a name matches several. An exact, unrivaled name needs no choice. Answers below 0.55, or less
  than 0.15 ahead of the runner-up, count as no answer. Jev uses the interpreter's route: the
  user's own key, then `CirceDecisionLive` (node key or relay). It never uses the provider-first
  judgement given to the older loop.

Typed text must come from the user's words and numbers, reshaped for the app ("fifty plus three"
may become `50+3`), or from text the requester supplied. Circe rejects other text and asks the
planner again.

Success needs a fresh observation. The app may show the planned result as a value it produced
itself, rather than text Circe typed. Two independent sources then agree, so code accepts it. Jev
is not asked because it cannot reliably evaluate arithmetic written in words. When the expected
result is only the text Circe typed, such as a search box holding the words, Jev decides whether
anything in the goal remains. With no expected result, Jev reads the window. A planner's claim
never counts. Stops are checked in the host adapter immediately before every input and through
an abort signal in circe-core. A `dispatched-unknown` error ends the goal as uncertain.

## Grounding without guessing

Circe missions and provider tools share the same grounding rules, ported from Cua's jev-use runner.
They first call `get_window_state` with `include_screenshot: false`. A truncated tree gets one
larger read with `timeout_ms: 5000` and `max_elements: 20000`. A tree that remains truncated does
not trigger visual fallback just because it is partial.

Automatic visual fallback uses Cua's reasons: `tree_empty`, `no_application_elements`, or
`no_native_candidates`. Window roots, window chrome, the macOS menu bar, and unlabeled macOS
window buttons do not establish application content. Missing tokens or frames make individual
native rows unusable without invalidating the rest of the observation.

When visual grounding is available and needed, one further `get_window_state` with
`include_screenshot: true` supplies both the accessibility snapshot and the screen capture.
`snapshot_id` scopes native element tokens; `capture_id` names the image retained by Cua. These
are different identities. `parse_visual_regions` parses exactly that capture. Do not combine
tokens from an earlier read with a later capture.

Circe validates the parse as Cua's jev-use `parseVisualRegions` does: schema, capture id, source
window pid and `window_id`, PNG provenance and screenshot size, invertible coordinate mapping,
and well-formed regions inside the image. A mismatch rejects the whole visual result.

Visual candidates are OCR text and detected controls containing exactly one text region. Unlabeled
icons are not offered. A visual candidate is dropped when an actionable native control already
has the same name, after case and whitespace normalization. The step model selects candidate ids
from bounded descriptions, including names, roles, values, and state. Visual coordinates and
capture ids stay in the server's executable map; the model does not invent an action address.

If the step model returns `confidence-too-low` or `missing-parameter`, the loop can ask once for
a richer observation of the same window and select again. This only happens when the previous
observation skipped visual parsing. Automatic fallback is reevaluated at each observation; usable
native controls take priority again when they appear. Explicit escalation applies to that window
for the mission. Expect about 6-8 seconds per parse on a 15 W laptop
CPU with the detector's fixed 1280x1280 YOLOv9-E input.

If automatic fallback is needed, visual grounding is unavailable, and the observation has no
reachable controls, the mission returns typed `unavailable` with the reason. It does not guess
coordinates. Missing or unhealthy perception leaves native grounding usable; computer access
state carries a `limitation` for the Computer card.

## Input and effect semantics

Visual candidates are click-only. The core refuses type or press targets read from pixels with
`unsupported-target`. A visual click sends `pid`, `window_id`, the region center as `x` and `y`,
`capture_id`, and `delivery_mode: foreground`. This physically clicks the observed pixel on the
verified target window; background coordinate routing may substitute a label's accessibility
action without activating its control. Native element actions remain in background. A capture authorizes at most one click. Circe marks
it consumed before dispatch, and Cua also consumes it on action admission.

Capture refusal codes and `stale_element_token`, when reported as `refused` or `not-dispatched`,
mean the input was not applied. The loop observes again. It never retries without the capture or
through a weaker target. Other refusals stop the step.

The host preserves `verified`, `dispatched-unknown`, `not-dispatched`, and `refused`. A clean
dispatch can have an effect the driver could not verify, such as a pixel click reported as
`Unverifiable`. For actions inside the observed window, `dispatched-unknown` with `isError: false`
continues without retrying that dispatch. The step loop observes again and checks the goal; two
consecutive actions without an observed change stop it for no progress. An explicit action goal,
such as a single click, can finish on dispatch evidence alone. Launches remain strict and require
a verified result.

Delivery uncertainty stops the mission: an interrupted, timed-out, or failed dispatch reported
with `isError: true` and `dispatched-unknown` is never repeated or called successful. Driver exit
also ends the mission. Audit records exclude typed text, clipboard contents, window titles, and
file paths.

## Provider observations

`computer_window_state` returns controls with an observation-scoped `controlId` and a `source` of
`native` or `visual`. Its optional `lookCloser` input requests visual parsing even when native
grounding stands; its optional `limitation` result explains unavailable or failed screen reading.
`computer_click` requires a `controlId`; there is no coordinate click. Background typing requires
a native text field controlId. Typing without one requires explicit foreground delivery and an
exact window target from the latest observation. Foreground keys have the same target requirement.
An input dispatch retires the old observation. Click and type return a new window observation
for the next input; if that read fails, the action result retains its delivery classification and
reports the read error. Unknown delivery remains fenced until a read succeeds. A rejected typing
request that never dispatches preserves its observation.

Provider action results stay strict: `ok` is true only for a verified effect. A clean unverified
dispatch still returns its effect with `ok: false`, so the provider must inspect the window before
claiming the goal finished.

## Perception distribution

The app packages only the signed catalog and `distribution.json` archive URL for each published
build target under `resources/cua-perception/<target>/`. The archive is downloaded on first use,
not bundled into the app. A target without both resource files has no bundled perception source.

On the first mission call, the host starts provisioning in the background. It checks
`extension_status` against the bundled version and skips installation when that version is healthy.
Otherwise it stages the archive under `<baseDir>/cua-driver/perception-staging`, checks its size
and SHA-256 against the signed payload, and asks Cua for an `install_extension` preview. It confirms
only the returned plan, with `confirm: true` and that plan's `plan_sha256`. Cua verifies the signature,
hashes, and publisher trust root itself and installs into its own store. Circe deletes the staged
archive after a successful install.

Circe gives Cua its own home, `<baseDir>/cua-driver`, through `CUA_DRIVER_RS_HOME`. Its extension
store and publisher trust must stay separate from another Cua installation. Failed provisioning
does not disable accessible apps. Capabilities come from the loaded driver's tool manifest, not
its version number. `visualGrounding` requires `parse_visual_regions`, `click.capture_id`, and
an installed, healthy extension, plus capture permission.

Distribution catalogs expire after 365 days and need refreshing in a Circe release. Static CI
verifies catalog signatures, expiry, target identity, and URL metadata; release preflight downloads and audits the archives. The gate
rejects retired AGPL detector artifacts, prohibited names, copyleft SBOM licenses, or missing
notices and SBOM. See the [release runbook](../operations/release.md#cua-perception-distribution).
