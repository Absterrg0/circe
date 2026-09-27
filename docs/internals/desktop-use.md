# Computer use

Computer use lets a node operate its own desktop. Cua Driver is the actuator. The feature is split
across three owners, and no single process both authorizes an action and performs it.

## Owners

The **desktop host** runs in the Electron main process under the Full preset. It starts the Cua
runtime, owns the OS session and its permissions, hosts input interruption, and listens on one
authenticated local socket. The host validates the caller capability, relays calls, binds every
session-aware call to the mission's own driver session, revokes queued work when a connection or
mission ends, and reports runtime exit. It holds no policy.

The runtime is the in-process SDK (`CuaDriver.create`). The documented macOS embedded-daemon
topology (`EmbeddedCuaDriverHost`, where grants attach to the app's TCC responsibility chain) is
not implemented yet; on macOS today the in-process runtime is what runs and its permission story is
unproven. Treat macOS and Windows as unqualified until the platform evidence exists.

`desktop_status` reports states separately: graphical session present, runtime state, driver-reported
route/permission facts, and per-capability flags. An environment variable is never evidence of a
working input route, and `available` is false once the runtime has failed.

The **server** owns policy: capability advertisement, mission activation and consent, tool
admission, cancellation, and audit. It receives the host endpoint and capability in the desktop
bootstrap envelope and connects as a client. No connected host means no computer capability; the
server never spawns the runtime itself and never talks to Cua directly.

**Providers** receive a curated, mission-scoped tool surface. They never address the host, the
socket, or the Cua tool catalog at large.

## Missions

A mission is one turn-scoped authorization with an id, a goal, a start time, and the consent that
created it. The user starts a mission from the UI or voice lane; a model cannot start, widen, or
renew one. Provider tools are advertised only while a mission is active. Every call carries the
mission id, and the server refuses calls with no active mission, an ended mission, or a mismatched
id. Ending a mission interrupts in-flight input, fences queued work, and releases the driver session.
A driver exit ends the mission and is reported; uncertain mutations are never replayed.

## Transport

The desktop host listens on a private unix socket (named pipe on Windows) in a per-run directory and
write-protects it. The server connects and sends one newline-delimited JSON hello with the
capability from the bootstrap envelope; the host rejects every other caller. Requests and replies
are id-correlated on the same connection. The host pushes events on that connection:
`input-interrupted`, `driver-exit`, `runtime-state`, `permission-changed`. Frame content, typed text,
titles, and paths never appear in events.

## Safety invariants

- Input interruption (chat Stop today; physical Escape, lock/sleep, and permission loss with the
  platform listeners) stops new mutations until the host reports a fresh observation; input is
  never replayed after an uncertain result.
- A call result distinguishes `verified`, `dispatched-unknown`, `not-dispatched`, and `refused`.
  Unknown dispatch is never promoted to success.
- Audit entries record tool, mission, target identity, effect, and timing. They exclude typed text,
  clipboard contents, window titles, and file paths.
- Wayland sessions without a proven input route refuse mutation rather than fabricating one, and
  capture-only sessions stay observation-only.

## Mission surface

`CirceComputerAccess` is the node's one owner of the computer. It holds at most one request waiting
for approval and at most one holder, matching the single mission slot, and every route goes through
it: Circe on the user's behalf, the Computer panel, the interaction route's desktop missions, and
coding agents. Nothing touches the computer before the user approves, and a new goal replaces a
waiting one with its own approval: a correction never inherits consent. Clients read the owner's
state through `circe.computerAccess.subscribe` and settle it with typed `decide` and `stop`, so an
approval never depends on hearing a spoken notice, works on a second device or after a reconnect,
and works on a node without circe-core.

Circe reaches it through circe-core. The node host puts "This computer" in circe-core's world as a
project, and each request is its own thread. circe-core finds what a start created by the thread id
that appeared, so a fresh id per request is what makes undo reach the request and makes circe-core
watch it until it finishes. Only the asker that made a waiting request may replace it (the same
device session, or the same agent run for the same goal), so a yes is never spent on a question its
speaker did not hear. A waiting request is a question, not an approval: circe-core settles
approvals by itself under the user's standing rules, and using the computer always needs the user's
own answer. The host reads that answer itself. A plain yes or no settles the request only for the
device session that was asked, which each client names with an `origin` on every host message;
anything else is a new goal. A typed decision names the exact request the client showed, from any
device.

Circe's approved goals run in the deterministic step loop, which grounds the goal to an application
and window, reads its accessibility elements, and applies one step at a time through the audited
service calls. The run belongs to the node's scope, not to the request that approved it, and it
settles on every exit; an interrupted run is `uncertain`, never replayed.

Providers see a curated `computer_*` tool surface. `computer_begin` asks for the computer through
the same owner, bound to the agent's current run. Approval first checks that run is still the
thread's running one, then starts a mission owned by that exact provider thread and session; a
request withdrawn while its mission was being admitted gets that mission ended at once. The action
tools (app and window listing, window state with element tokens, click, type, key, scroll, launch)
work only under it. They refuse with `mission-required` without one and `mission-owner-mismatch`
under someone else's, so a model never starts, widens, borrows, or renews authority. The end of that
exact run withdraws a waiting request or hands the computer back, as do `computer_end`, a user stop,
and the native mission ending. Another run in the same thread ending changes nothing. Every tool
call also checks that the thread's running run is the one granted, so a later run in the same
provider session never inherits the grant, and a missed run-end event is caught there and after the
holder watch resubscribes.

The previous server-side actuator (AT-SPI and OS CLI helpers under `apps/server/src/circe/desktopUse`)
has been removed. The desktop host is the only computer-use path; no server-local helper spawns OS
input.
