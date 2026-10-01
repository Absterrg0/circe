import type { ComputerHostToolResult } from "@circe/contracts";
import type { ComputerElement } from "@circe/core/computerUse";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  isActionableRole,
  readVisualRegions,
  visualFallbackReason,
  VisualObservationError,
  type CuaPlatform,
  type VisualFallbackReason,
  type VisualRegion,
} from "./cuaObservation.ts";
import {
  groundElements,
  observationIsPartial,
  readOnlyText,
  readWindowState,
} from "./driverSchemas.ts";

/**
 * Grounded observation of one exact window, shared by Circe's own missions and
 * provider computer tools. The Cua driver owns every pixel, element and input;
 * this module only decides which Cua observation to ask for and turns it into
 * a finite set of candidates whose executable addresses stay host-side.
 *
 * Native accessibility is the primary source. A truncated tree is reobserved
 * once with a larger budget before it is judged. Only when Cua's own fallback
 * rules say native grounding cannot work (an empty tree, only window chrome,
 * or no actionable controls) does the observation take a screenshot capture
 * and parse that exact capture into visual regions. Visual candidates are
 * click-only and bound to the capture that produced them.
 */

const isVisualObservationError = Schema.is(VisualObservationError);

const TRUNCATED_REOBSERVE = { timeout_ms: 5_000, max_elements: 20_000 } as const;
const PARSE_OPTIONS = { kinds: ["text", "icon"], min_confidence: 0.05, max_regions: 100 } as const;
/** OCR text below this confidence is not offered as a target. */
const MIN_TEXT_CONFIDENCE = 0.5;
/** icon_detect_v3 is deliberately low-confidence on small controls. */
const MIN_ICON_CONFIDENCE = 0.1;
const MAX_VISUAL_CANDIDATES = 40;

export interface GroundedTarget {
  readonly pid: number;
  readonly windowId: number;
}

/**
 * How the host acts on a candidate. The model only ever sees the candidate id;
 * a visual point is valid only with the capture it was read from.
 */
export type GroundedExecutable =
  | { readonly kind: "native"; readonly token: string }
  | {
      readonly kind: "visual";
      readonly captureId: string;
      readonly x: number;
      readonly y: number;
    };

export interface ObservationReport {
  /** Set when a truncated tree was reobserved with a larger budget. */
  readonly reobserved: boolean;
  readonly fallback: VisualFallbackReason | "escalated" | undefined;
  readonly visual: "skipped" | "parsed" | "unavailable" | "failed";
  /** Driver or validation code when the visual path did not produce regions. */
  readonly visualCode?: string;
  readonly nativeCandidates: number;
  readonly visualCandidates: number;
  readonly observeMs: number;
  readonly parseMs?: number;
}

export interface GroundedObservation {
  readonly target: GroundedTarget;
  readonly title: string | undefined;
  readonly appName: string | undefined;
  /** Accessibility snapshot scoping the native tokens. Never a capture id. */
  readonly snapshotId: string | undefined;
  /** The screen capture the visual candidates were read from, when parsed. */
  readonly captureId: string | undefined;
  readonly degraded: boolean;
  readonly elements: ReadonlyArray<ComputerElement>;
  readonly text?: ReadonlyArray<string>;
  readonly executables: ReadonlyMap<string, GroundedExecutable>;
  readonly report: ObservationReport;
}

export class GroundingError extends Schema.TaggedError<GroundingError>()("GroundingError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export type GroundingCall<E> = (
  tool: string,
  args: Record<string, unknown>,
) => Effect.Effect<ComputerHostToolResult, E>;

export interface ObserveGroundedInput<E> {
  readonly call: GroundingCall<E>;
  readonly target: GroundedTarget;
  readonly platform: CuaPlatform;
  /** The host reported visual grounding: capture-bound clicks and a healthy parser. */
  readonly visualAvailable: boolean;
  /** `visual` parses the capture even when native grounding stands. */
  readonly mode?: "auto" | "visual";
  readonly app?: string;
}

const readState = <E>(
  call: GroundingCall<E>,
  target: GroundedTarget,
  extra: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const result = yield* call("get_window_state", {
      pid: target.pid,
      window_id: target.windowId,
      ...extra,
    });
    if (result.isError)
      return yield* new GroundingError({
        reason: result.text.length > 0 ? result.text : "The window could not be observed.",
      });
    const state = readWindowState(result.structured);
    if (state === undefined)
      return yield* new GroundingError({ reason: "The window observation could not be read." });
    if (
      (state.pid !== undefined && state.pid !== target.pid) ||
      (state.window_id !== undefined && state.window_id !== target.windowId)
    )
      return yield* new GroundingError({
        reason: "The driver observed a different window than the one requested.",
      });
    return state;
  });

const regionName = (region: VisualRegion): string => region.text ?? region.label ?? "";

const contains = (outer: VisualRegion, inner: VisualRegion): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

const fold = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Visual candidates from validated regions. OCR text is offered by its text.
 * A detected control that contains exactly one text region takes that text
 * as its name and replaces it, so the click lands on the control's center.
 * Unlabeled icons are not offered: the detector gives them no meaning a
 * choice could rest on. Anything a native element already names is dropped,
 * so native grounding wins when both see the same control.
 */
const visualCandidates = (
  regions: ReadonlyArray<VisualRegion>,
  captureId: string,
  nativeNames: ReadonlySet<string>,
  app: string | undefined,
): Array<{ element: ComputerElement; executable: GroundedExecutable }> => {
  const texts = regions.filter(
    (region) => region.kind === "text" && region.confidence >= MIN_TEXT_CONFIDENCE,
  );
  const consumed = new Set<string>();
  const chosen: Array<{ region: VisualRegion; name: string; role: string }> = [];
  for (const icon of regions) {
    if (icon.kind !== "icon" || icon.confidence < MIN_ICON_CONFIDENCE) continue;
    const inside = texts.filter((text) => contains(icon, text));
    if (inside.length !== 1) continue;
    consumed.add(inside[0]!.id);
    chosen.push({ region: icon, name: regionName(inside[0]!), role: "control" });
  }
  for (const text of texts)
    if (!consumed.has(text.id)) chosen.push({ region: text, name: regionName(text), role: "text" });
  return chosen
    .filter((entry) => entry.name.length > 0 && !nativeNames.has(fold(entry.name)))
    .slice(0, MAX_VISUAL_CANDIDATES)
    .map(({ region, name, role }) => ({
      element: {
        id: `visual:${region.id}`,
        source: "visual" as const,
        role,
        name,
        ...(app === undefined ? {} : { app }),
        bounds: { x: region.x, y: region.y, width: region.width, height: region.height },
      },
      executable: {
        kind: "visual" as const,
        captureId,
        x: region.x + region.width / 2,
        y: region.y + region.height / 2,
      },
    }));
};

export const observeGrounded = <E>(
  input: ObserveGroundedInput<E>,
): Effect.Effect<GroundedObservation, E | GroundingError> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const mode = input.mode ?? "auto";
    let state = yield* readState(input.call, input.target, { include_screenshot: false });
    let reobserved = false;
    if (state.truncated === true || (state.truncation_reason ?? "").length > 0) {
      reobserved = true;
      state = yield* readState(input.call, input.target, {
        include_screenshot: false,
        ...TRUNCATED_REOBSERVE,
      });
    }
    const actionable = (s: typeof state) =>
      groundElements(s).filter((element) => isActionableRole(element.role, input.platform));
    const fallback =
      mode === "visual"
        ? ("escalated" as const)
        : visualFallbackReason(state, input.platform, actionable(state).length, reobserved);

    let visual: ObservationReport["visual"] = "skipped";
    let visualCode: string | undefined;
    let parseMs: number | undefined;
    let captureId: string | undefined;
    let visualEntries: ReturnType<typeof visualCandidates> = [];
    if (fallback !== undefined && !input.visualAvailable) {
      visual = "unavailable";
      visualCode = "visual_grounding_unavailable";
    } else if (fallback !== undefined) {
      // One observation supplies both halves: its snapshot scopes the native
      // tokens and its capture is the exact image that is parsed and clicked.
      state = yield* readState(input.call, input.target, {
        include_screenshot: true,
        ...(reobserved ? TRUNCATED_REOBSERVE : {}),
      });
      const capture = state.capture_id ?? undefined;
      if (capture === undefined) {
        visual = "failed";
        visualCode = "capture_missing";
      } else {
        const parseStarted = yield* Clock.currentTimeMillis;
        const parsed = yield* input.call("parse_visual_regions", {
          capture_id: capture,
          options: PARSE_OPTIONS,
        });
        parseMs = (yield* Clock.currentTimeMillis) - parseStarted;
        if (parsed.isError) {
          visual = parsed.driverCode === "not_installed" ? "unavailable" : "failed";
          visualCode = parsed.driverCode ?? parsed.refusalCode ?? "parse_failed";
        } else {
          const regions = readVisualRegions(parsed.structured, {
            captureId: capture,
            pid: input.target.pid,
            windowId: input.target.windowId,
            width: state.screenshot_width ?? undefined,
            height: state.screenshot_height ?? undefined,
          });
          if (isVisualObservationError(regions)) {
            visual = "failed";
            visualCode = regions.code;
          } else {
            visual = "parsed";
            captureId = capture;
            const nativeNames = new Set(
              actionable(state)
                .map((element) => fold(element.name))
                .filter((name) => name.length > 0),
            );
            visualEntries = visualCandidates(
              regions.regions,
              capture,
              nativeNames,
              state.app_name ?? input.app,
            );
          }
        }
      }
    }

    const app = state.app_name ?? input.app;
    const executables = new Map<string, GroundedExecutable>();
    const native: ComputerElement[] = groundElements(state).map((element) => {
      executables.set(element.token, { kind: "native", token: element.token });
      return {
        id: element.token,
        source: "native" as const,
        role: element.role,
        name: element.name,
        ...(element.value === undefined ? {} : { value: element.value }),
        ...(element.state === undefined ? {} : { state: element.state }),
        ...(element.description === undefined ? {} : { description: element.description }),
        ...(element.editable === undefined ? {} : { editable: element.editable }),
        ...(app === undefined ? {} : { app }),
        bounds: element.bounds,
      };
    });
    for (const entry of visualEntries) executables.set(entry.element.id, entry.executable);
    return {
      target: input.target,
      text: readOnlyText(state),
      title: state.window_title ?? undefined,
      appName: app,
      snapshotId: state.snapshot_id ?? undefined,
      captureId,
      degraded: observationIsPartial(state),
      elements: [...native, ...visualEntries.map((entry) => entry.element)],
      executables,
      report: {
        reobserved,
        fallback,
        visual,
        ...(visualCode === undefined ? {} : { visualCode }),
        nativeCandidates: native.length,
        visualCandidates: visualEntries.length,
        observeMs: (yield* Clock.currentTimeMillis) - started,
        ...(parseMs === undefined ? {} : { parseMs }),
      },
    } satisfies GroundedObservation;
  });

/** The one exact Cua click for a grounded candidate. */
export const clickArguments = (
  target: GroundedTarget,
  executable: GroundedExecutable,
  visualDelivery: "background" | "foreground" = "background",
): Record<string, unknown> =>
  executable.kind === "native"
    ? {
        pid: target.pid,
        window_id: target.windowId,
        element_token: executable.token,
        delivery_mode: "background",
      }
    : {
        pid: target.pid,
        window_id: target.windowId,
        x: executable.x,
        y: executable.y,
        capture_id: executable.captureId,
        delivery_mode: visualDelivery,
      };

/**
 * Driver codes for a capture-bound click the driver refused before any input
 * was dispatched. They call for a fresh capture, never for an unbound retry.
 */
export const CAPTURE_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "capture_id_invalid",
  "capture_not_found",
  "capture_expired",
  "capture_generation_mismatch",
  "capture_target_mismatch",
  "capture_coordinate_invalid",
  "capture_frame_mismatch",
  "capture_action_refused",
  "capture_stale",
]);
