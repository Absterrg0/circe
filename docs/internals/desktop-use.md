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

Two things start a mission, and both are user-initiated: the computer panel in the app, and the
voice lane. A mission holds the goal, the consent that created it, and the client request id that
can cancel it. The deterministic step loop runs inside the mission: it grounds the goal to an
application and window through the driver, reads the window's accessibility elements, selects one
step at a time, and applies it through the same audited service calls a provider would use.

Providers see a curated `computer_*` tool surface: status, app and window listing, window state
with element tokens, and click, type, key, scroll, and launch actions. Every action tool refuses
with `mission-required` until a mission is active, and with `mission-owner-mismatch` when the active
mission belongs to another origin, so a model can never start, widen, borrow, or renew authority.

Provider-owned missions are not created by any production path yet: explicit user-approved
delegation through the ordinary provider flow is still to build. Until then, provider computer tools
refuse and the deterministic client-owned mission is the working path. The node's guidance says so
instead of telling the model to retry.

The previous server-side actuator (AT-SPI and OS CLI helpers under `apps/server/src/circe/desktopUse`)
has been removed. The desktop host is the only computer-use path; no server-local helper spawns OS
input.
