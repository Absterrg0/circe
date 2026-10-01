import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Decoders for the Cua driver's JSON tool results as they cross the desktop
 * host socket. The pinned driver contract is the source of truth: nearly every
 * observation field is optional, so a row without a frame or token must not
 * invalidate the whole observation. Unknown fields are ignored; missing ones
 * keep their structural meaning.
 */

const CuaFrame = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  w: Schema.Number,
  h: Schema.Number,
});

export const CuaWindow = Schema.Struct({
  window_id: Schema.Number,
  pid: Schema.Number,
  app_name: Schema.String,
  title: Schema.String,
  z_index: Schema.optional(Schema.NullOr(Schema.Number)),
  is_on_screen: Schema.optional(Schema.Boolean),
});
export type CuaWindow = typeof CuaWindow.Type;

export const CuaApp = Schema.Struct({
  pid: Schema.Number,
  name: Schema.String,
  running: Schema.Boolean,
  active: Schema.optional(Schema.Boolean),
  launch_path: Schema.optional(Schema.NullOr(Schema.String)),
  kind: Schema.optional(Schema.NullOr(Schema.String)),
  bundle_id: Schema.optional(Schema.NullOr(Schema.String)),
  windows: Schema.optional(Schema.Array(CuaWindow)),
});
export type CuaApp = typeof CuaApp.Type;

export const CuaElement = Schema.Struct({
  element_index: Schema.optional(Schema.Number),
  parent_index: Schema.optional(Schema.NullOr(Schema.Number)),
  element_token: Schema.optional(Schema.NullOr(Schema.String)),
  role: Schema.optional(Schema.NullOr(Schema.String)),
  label: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  value: Schema.optional(Schema.NullOr(Schema.String)),
  value_description: Schema.optional(Schema.NullOr(Schema.String)),
  enabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
  editable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  selected: Schema.optional(Schema.NullOr(Schema.Boolean)),
  in_web_content: Schema.optional(Schema.NullOr(Schema.Boolean)),
  actions: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  depth: Schema.optional(Schema.Number),
  frame: Schema.optional(Schema.NullOr(CuaFrame)),
  min: Schema.optional(Schema.NullOr(Schema.Number)),
  max: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type CuaElement = typeof CuaElement.Type;

/**
 * One `get_window_state` observation. Two identities travel with it and must
 * not be confused: `snapshot_id` scopes the accessibility `element_token`s,
 * and `capture_id` names the screenshot the driver retains for visual parsing
 * and capture-bound clicks. A capture exists only when a screenshot was taken.
 */
export const CuaWindowState = Schema.Struct({
  tree_markdown: Schema.optional(Schema.NullOr(Schema.String)),
  pid: Schema.optional(Schema.Number),
  window_id: Schema.optional(Schema.Number),
  window_title: Schema.optional(Schema.NullOr(Schema.String)),
  app_name: Schema.optional(Schema.NullOr(Schema.String)),
  snapshot_id: Schema.optional(Schema.NullOr(Schema.String)),
  capture_id: Schema.optional(Schema.NullOr(Schema.String)),
  /** `window`: action and element coordinates are pixels of this screenshot. */
  coordinate_frame: Schema.optional(Schema.NullOr(Schema.String)),
  screenshot_width: Schema.optional(Schema.NullOr(Schema.Number)),
  screenshot_height: Schema.optional(Schema.NullOr(Schema.Number)),
  screenshot_scale: Schema.optional(Schema.NullOr(Schema.Number)),
  screenshot_frame_valid: Schema.optional(Schema.NullOr(Schema.Boolean)),
  elements: Schema.optional(Schema.Array(CuaElement)),
  total_element_count: Schema.optional(Schema.Number),
  returned_element_count: Schema.optional(Schema.Number),
  elements_complete: Schema.optional(Schema.NullOr(Schema.Boolean)),
  degraded: Schema.optional(Schema.NullOr(Schema.Boolean)),
  degraded_reason: Schema.optional(Schema.NullOr(Schema.String)),
  truncated: Schema.optional(Schema.NullOr(Schema.Boolean)),
  truncation_reason: Schema.optional(Schema.NullOr(Schema.String)),
  window_bounds: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        x: Schema.Number,
        y: Schema.Number,
        width: Schema.Number,
        height: Schema.Number,
      }),
    ),
  ),
});
export type CuaWindowState = typeof CuaWindowState.Type;

const decodeWindows = Schema.decodeUnknownOption(
  Schema.Struct({ windows: Schema.Array(CuaWindow) }),
);
const decodeApps = Schema.decodeUnknownOption(Schema.Struct({ apps: Schema.Array(CuaApp) }));
const decodeWindowState = Schema.decodeUnknownOption(CuaWindowState);

export const readWindows = (structured: unknown): ReadonlyArray<CuaWindow> => {
  const decoded = decodeWindows(structured);
  return decoded._tag === "Some" ? decoded.value.windows : [];
};

export const readApps = (structured: unknown): ReadonlyArray<CuaApp> => {
  const decoded = decodeApps(structured);
  return decoded._tag === "Some" ? decoded.value.apps : [];
};

/** The raw window state, with every optional field preserved. */
export const readWindowState = (structured: unknown): CuaWindowState | undefined => {
  const decoded = decodeWindowState(structured);
  return decoded._tag === "Some" ? decoded.value : undefined;
};

export interface GroundedElement {
  readonly token: string;
  readonly role: string | null;
  readonly name: string;
  readonly value: string | undefined;
  readonly state: string | undefined;
  /** The accessible description, such as a tooltip ("Calculate Result"). */
  readonly description: string | undefined;
  /**
   * Whether the element takes typed text: true when it offers a text action,
   * false when it only offers clipboard or selection actions (read-only
   * text), unknown otherwise.
   */
  readonly editable: boolean | undefined;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/** Compact state names the planner can reason about, such as selected or checked. */
const elementState = (element: CuaElement): string | undefined => {
  const parts: string[] = [];
  if (element.selected === true) parts.push("selected");
  if (element.enabled === false) parts.push("disabled");
  if (element.in_web_content === true) parts.push("web-content");
  if (element.actions !== undefined && element.actions !== null && element.actions.length > 0)
    parts.push(`actions:${element.actions.join("|")}`);
  return parts.length === 0 ? undefined : parts.join(",");
};

const elementEditable = (element: CuaElement): boolean | undefined => {
  if (element.editable !== undefined && element.editable !== null) return element.editable;
  const actions = element.actions ?? [];
  if (actions.some((action) => ["clipboard.cut", "clipboard.paste"].includes(action))) return true;
  if (actions.some((action) => action.startsWith("text."))) return true;
  if (actions.some((action) => action.startsWith("clipboard.") || action.startsWith("selection.")))
    return false;
  return undefined;
};

/** Cua also observes passive labels that have no indexed action token. */
export const readOnlyText = (state: CuaWindowState): ReadonlyArray<string> => {
  const labels: string[] = [];
  for (const line of (state.tree_markdown ?? "").split("\n")) {
    const match = /^\s*- (?:label|static|text) = ("(?:[^"\\]|\\.)*")\s*$/u.exec(line);
    if (match === null) continue;
    try {
      const label: unknown = JSON.parse(match[1]!);
      if (typeof label === "string" && label.trim().length > 0) labels.push(label.slice(0, 200));
    } catch {
      /* A malformed tree line is not evidence. */
    }
  }
  return [...new Set(labels)].slice(0, 100);
};

/**
 * Elements usable for grounding. A row without a token or frame stays valid in
 * the observation but cannot be acted on, so it is dropped here instead of
 * rejecting the entire snapshot.
 */
export const groundElements = (state: CuaWindowState): ReadonlyArray<GroundedElement> =>
  (state.elements ?? []).flatMap((element) => {
    const token = element.element_token;
    const frame = element.frame;
    if (token === undefined || token === null || token.length === 0) return [];
    if (frame === undefined || frame === null) return [];
    return [
      {
        token,
        role: element.role ?? null,
        name: element.label ?? element.value ?? "",
        value: element.value ?? undefined,
        state: elementState(element),
        description:
          element.description === undefined ||
          element.description === null ||
          element.description.length === 0
            ? undefined
            : element.description,
        editable: elementEditable(element),
        bounds: {
          x: frame.x,
          y: frame.y,
          width: frame.w,
          height: frame.h,
        },
      },
    ];
  });

/** Whether the observation is partial, so the planner knows what it can establish. */
export const observationIsPartial = (state: CuaWindowState): boolean =>
  state.degraded === true ||
  state.truncated === true ||
  state.elements_complete === false ||
  groundElements(state).length < (state.elements ?? []).length;

/** The process identity returned by a completed app launch, when available. */
export const readLaunchPid = (value: unknown): number | undefined =>
  Schema.decodeUnknownOption(
    Schema.Struct({ pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)) }),
  )(value).pipe(
    Option.map((app) => app.pid),
    Option.getOrUndefined,
  );
