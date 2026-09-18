# The desktop surface

Circe drives the machine the node runs on. The design separates _what is on
screen_ from _who decides_ from _who acts_, because each has a different
failure mode and a different owner. It replaces the earlier arrangement where a
node-side loop both perceived with the accessibility tree and decided with
TypeSafe while the provider merely delegated one goal.

## Layers

```
platform capture + input      the driver (pixels, pointer, keyboard)
semantic accessibility       a per-platform accessibility adapter
perception (optional)        screenshot -> visual regions
surface                      one DesktopSnapshot per capture, capture-bound act
decision                     TypeSafe (Jev) picks among offered regions
planner                      the provider harness (MCP tools), or a local loop
```

- **Driver.** `desktopUse/` already captures pixels and injects pointer and
  keyboard events on macOS, Windows, Linux X11, and Linux Wayland
  (`platforms.ts`, `macos.ts`, `windows.ts`). It is the actuator primitive and
  stays platform-specific only in its command tables.
- **Accessibility adapter.** The semantic tree is the cheap, high-fidelity
  surface where it exists. It is the one platform-specific gap: `AT-SPI` on
  Linux today, `AX` on macOS and `UIA` on Windows to follow. The adapter
  interface is `observe()` plus a capture-bound `activate`/`set-text` that
  names the element identity it was observed with.
- **Perception.** Optional and pluggable: a screenshot plus an interpreter
  yields visual regions in the same shape as semantic ones. The default is
  none, so an a11y node never pays for it. No third-party model weights ship
  in the core; an implementation is a separately-licensed extension.
- **Surface.** `@circe/core/desktopSurface` owns the pure contract: a capture
  yields one `DesktopSnapshot` (a `captureId`, a source, bounded regions), and
  every action names the capture it was chosen against. The service caches the
  snapshot, revalidates the target's identity against the live surface, and
  refuses as `stale-capture` when the screen moved on. This generalizes the
  `element-changed` refusal the AT-SPI action already performs.
- **Decision.** TypeSafe returns one typed choice among the offered region ids.
  It never invents a target; the surface revalidates whatever it returns. The
  "unverified" completion rule applies: a done with no applied action is
  reported as unverified, never as success.
- **Planner.** The provider's own harness drives the loop through MCP tools
  (`desktop_observe` -> `desktop_decide` -> `desktop_act`), so a long mission
  keeps its context in the provider session instead of restarting per step. A
  providerless mission (a voice or WebSocket request with no provider running)
  runs the same three calls in a bounded local loop; it is the same service,
  not a parallel stack.

## Why capture-bound

A pixel is not an identity. Between observing and acting, a window can move, a
list can scroll, and the button at those coordinates can become _Delete_. The
snapshot id plus the element identity (`role`, `name`, bounds at resolution)
let the surface refuse rather than mis-click. This is the same discipline
TypeSafe grounding gives text: choose only from what was offered.

## Safety and authority

- A `headless` preset owns execution but no surface; the surface refuses.
- Confirmation is typed state, required once per session before the first
  mission. A model never authorizes a tool.
- The visual tools need a model that can see; `@circe/core/modelVision`
  decides from the selected model id. A text-only model is refused with a
  clear message rather than handed an unusable image, and the command center
  offers only multimodal models for desktop use.

## Licensing

The core copies no third-party computer-use code and bundles no third-party
model weights. OmniParser is Microsoft's, not Cua's; Cua isolates it as an
optional AGPL-3.0 extension. Circe keeps the same boundary: perception is an
optional extension, and a shipped grounder must be permissively licensed or
the provider's own multimodal model.

## Migration

`desktop_run_goal` and the node-side `runComputerUse` loop are removed. The
browser mission keeps its own surface but moves onto the same snapshot and
capture-bound action contract.
