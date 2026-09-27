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
});
export type CuaApp = typeof CuaApp.Type;

export const CuaElement = Schema.Struct({
  element_index: Schema.optional(Schema.Number),
  element_token: Schema.optional(Schema.NullOr(Schema.String)),
  role: Schema.optional(Schema.NullOr(Schema.String)),
  label: Schema.optional(Schema.NullOr(Schema.String)),
  value: Schema.optional(Schema.NullOr(Schema.String)),
  value_description: Schema.optional(Schema.NullOr(Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
  selected: Schema.optional(Schema.Boolean),
  in_web_content: Schema.optional(Schema.Boolean),
  actions: Schema.optional(Schema.Array(Schema.String)),
  depth: Schema.optional(Schema.Number),
  frame: Schema.optional(Schema.NullOr(CuaFrame)),
  min: Schema.optional(Schema.NullOr(Schema.Number)),
  max: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type CuaElement = typeof CuaElement.Type;

export const CuaWindowState = Schema.Struct({
  window_title: Schema.optional(Schema.NullOr(Schema.String)),
  app_name: Schema.optional(Schema.NullOr(Schema.String)),
  snapshot_id: Schema.optional(Schema.NullOr(Schema.String)),
  elements: Schema.optional(Schema.Array(CuaElement)),
  total_element_count: Schema.optional(Schema.Number),
  returned_element_count: Schema.optional(Schema.Number),
  elements_complete: Schema.optional(Schema.Boolean),
  degraded: Schema.optional(Schema.Boolean),
  degraded_reason: Schema.optional(Schema.NullOr(Schema.String)),
  truncated: Schema.optional(Schema.Boolean),
  truncation_reason: Schema.optional(Schema.NullOr(Schema.String)),
  window_bounds: Schema.optional(Schema.NullOr(CuaFrame)),
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
  if (element.actions !== undefined && element.actions.length > 0)
    parts.push(`actions:${element.actions.join("|")}`);
  return parts.length === 0 ? undefined : parts.join(",");
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
