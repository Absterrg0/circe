import * as Schema from "effect/Schema";

import type { CuaElement, CuaWindowState } from "./driverSchemas.ts";

/**
 * Interpretation of Cua Driver observations, ported from Cua's reference
 * jev-use runner (`libs/cua-driver/examples/jev-use/typescript`, RFC #4268)
 * so Circe decides native-versus-visual grounding the way Cua does:
 *
 * - `native_roles.ts`: the closed per-platform role tables and Driver's role
 *   normalization, used to tell actionable controls from structure.
 * - `native.ts`: `hasApplicationElements`, which separates window roots,
 *   window chrome and the macOS menu bar from application content.
 * - `core.ts`: `parseVisualRegions`, the validator a visual result must pass
 *   before any region may become an action target.
 */

export type CuaPlatform = "macos" | "windows" | "linux";

export const cuaPlatform = (platform: string | undefined): CuaPlatform =>
  platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";

type RoleClass =
  | "button"
  | "toggle"
  | "checkbox"
  | "radio"
  | "popup"
  | "menu_item"
  | "link"
  | "text_input";

const RAW_ROLES: Readonly<Record<CuaPlatform, Readonly<Record<RoleClass, readonly string[]>>>> = {
  macos: {
    button: ["AXButton"],
    toggle: ["AXSwitch"],
    checkbox: ["AXCheckBox"],
    radio: ["AXRadioButton"],
    popup: ["AXPopUpButton", "AXComboBox", "AXMenuButton"],
    menu_item: ["AXMenuItem", "AXMenuBarItem"],
    link: ["AXLink"],
    text_input: ["AXTextField", "AXTextArea", "AXSearchField", "AXSecureTextField"],
  },
  windows: {
    button: ["Button", "SplitButton"],
    toggle: [],
    checkbox: ["CheckBox"],
    radio: ["RadioButton"],
    popup: ["ComboBox"],
    menu_item: ["MenuItem"],
    link: ["Hyperlink"],
    text_input: ["Edit"],
  },
  linux: {
    button: ["push button", "button"],
    toggle: ["toggle button", "switch"],
    checkbox: ["check box"],
    radio: ["radio button"],
    popup: ["combo box"],
    menu_item: ["menu item", "check menu item", "radio menu item"],
    link: ["link"],
    text_input: ["entry", "text", "text box", "search box", "password text"],
  },
};

/** Port of Driver's `normalized_role` (cua-driver-core/src/expectation.rs). */
export const normalizedRole = (role: string): string => {
  let normalized = role.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.startsWith("ax")) normalized = normalized.slice(2);
  if (normalized === "pushbutton") return "button";
  if (normalized === "pagetab" || normalized === "tabitem") return "tab";
  return normalized;
};

const ROLE_TABLES: Readonly<Record<CuaPlatform, ReadonlyMap<string, RoleClass>>> = {
  macos: new Map(
    Object.entries(RAW_ROLES.macos).flatMap(([klass, roles]) =>
      roles.map((role) => [normalizedRole(role), klass as RoleClass] as const),
    ),
  ),
  windows: new Map(
    Object.entries(RAW_ROLES.windows).flatMap(([klass, roles]) =>
      roles.map((role) => [normalizedRole(role), klass as RoleClass] as const),
    ),
  ),
  linux: new Map(
    Object.entries(RAW_ROLES.linux).flatMap(([klass, roles]) =>
      roles.map((role) => [normalizedRole(role), klass as RoleClass] as const),
    ),
  ),
};

/** Window-manager containers whose descendants are not application controls. */
const WINDOW_CHROME_ROLES: Readonly<Record<CuaPlatform, ReadonlySet<string>>> = {
  macos: new Set(),
  windows: new Set([normalizedRole("TitleBar")]),
  linux: new Set(),
};

const WINDOW_ROOT_ROLES: ReadonlySet<string> = new Set(["window", "application", "frame"]);

export const isActionableRole = (role: string | null | undefined, platform: CuaPlatform) =>
  typeof role === "string" && role.length > 0 && ROLE_TABLES[platform].has(normalizedRole(role));

const normalizedOf = (element: CuaElement | undefined): string =>
  element !== undefined && typeof element.role === "string" ? normalizedRole(element.role) : "";

const indexElements = (elements: ReadonlyArray<CuaElement>): Map<number, CuaElement> => {
  const byIndex = new Map<number, CuaElement>();
  for (const element of elements)
    if (typeof element.element_index === "number") byIndex.set(element.element_index, element);
  return byIndex;
};

const ancestorMatches = (
  element: CuaElement,
  byIndex: Map<number, CuaElement>,
  test: (ancestor: CuaElement) => boolean,
  includeSelf: boolean,
): boolean => {
  const seen = new Set<number>();
  let current: CuaElement | undefined = includeSelf
    ? element
    : typeof element.parent_index === "number"
      ? byIndex.get(element.parent_index)
      : undefined;
  while (current !== undefined) {
    if (test(current)) return true;
    const parent = current.parent_index;
    if (typeof parent !== "number" || seen.has(parent)) return false;
    seen.add(parent);
    current = byIndex.get(parent);
  }
  return false;
};

/**
 * Whether any element is application content rather than window roots,
 * window chrome, the macOS menu bar or the macOS traffic-light buttons.
 * Mirrors jev-use `hasApplicationElements`.
 */
export const hasApplicationElements = (
  elements: ReadonlyArray<CuaElement>,
  platform: CuaPlatform,
): boolean => {
  const byIndex = indexElements(elements);
  const chrome = (element: CuaElement) => WINDOW_CHROME_ROLES[platform].has(normalizedOf(element));
  return elements.some((element) => {
    if (WINDOW_ROOT_ROLES.has(normalizedOf(element))) return false;
    if (ancestorMatches(element, byIndex, chrome, true)) return false;
    if (platform === "macos") {
      if (ancestorMatches(element, byIndex, (item) => normalizedOf(item) === "menubar", true))
        return false;
      const parent =
        typeof element.parent_index === "number" ? byIndex.get(element.parent_index) : undefined;
      const unlabeledWindowButton =
        normalizedOf(element) === "button" &&
        parent !== undefined &&
        WINDOW_ROOT_ROLES.has(normalizedOf(parent)) &&
        !element.label &&
        !element.value;
      if (unlabeledWindowButton) return false;
    }
    return true;
  });
};

/**
 * Why a native observation cannot ground the goal and the visual fallback
 * should run, or undefined when native grounding stands. Mirrors jev-use
 * `visualFallbackReason` without a task-declared target list: a truncated
 * tree is reobserved before it is judged, and a partial tree that still has
 * application content keeps native grounding.
 */
export type VisualFallbackReason =
  | "tree_empty"
  | "no_application_elements"
  | "no_native_candidates";

export const visualFallbackReason = (
  state: CuaWindowState,
  platform: CuaPlatform,
  nativeActionableCount: number,
  reobserved = false,
): VisualFallbackReason | undefined => {
  if (state.degraded === true && (state.degraded_reason ?? "").startsWith("ax_tree_empty"))
    return "tree_empty";
  const elements = state.elements ?? [];
  if (!reobserved && (state.truncated === true || (state.truncation_reason ?? "").length > 0))
    return undefined;
  if (state.elements_complete !== true)
    return hasApplicationElements(elements, platform) ? undefined : "no_application_elements";
  if (nativeActionableCount === 0) return "no_native_candidates";
  return undefined;
};

// ── Visual regions ───────────────────────────────────────────────────────

export interface VisualRegion {
  readonly id: string;
  readonly kind: "text" | "icon";
  readonly text: string | undefined;
  readonly label: string | undefined;
  readonly confidence: number;
  readonly interactive: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A validated parse of exactly one capture of exactly one window. */
export interface VisualObservation {
  readonly captureId: string;
  readonly pid: number;
  readonly windowId: number;
  readonly screenshotWidth: number;
  readonly screenshotHeight: number;
  readonly regions: ReadonlyArray<VisualRegion>;
}

export class VisualObservationError extends Schema.TaggedError<VisualObservationError>()(
  "VisualObservationError",
  {
    code: Schema.Literals(["capture_mismatch", "invalid_visual_result"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `The visual result was rejected: ${this.detail}`;
  }
}

const VisualResultShape = Schema.Struct({
  schema: Schema.String,
  capture: Schema.Struct({
    capture_id: Schema.String,
    source: Schema.Struct({
      kind: Schema.String,
      pid: Schema.optional(Schema.Number),
      window_id: Schema.optional(Schema.Number),
    }),
    screenshot: Schema.Struct({
      mime_type: Schema.String,
      reference: Schema.String,
      width: Schema.Number,
      height: Schema.Number,
    }),
    action_coordinate_space: Schema.Struct({
      kind: Schema.String,
      m11: Schema.optional(Schema.Number),
      m12: Schema.optional(Schema.Number),
      m21: Schema.optional(Schema.Number),
      m22: Schema.optional(Schema.Number),
      tx: Schema.optional(Schema.Number),
      ty: Schema.optional(Schema.Number),
    }),
  }),
  regions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.String,
      text: Schema.optional(Schema.NullOr(Schema.String)),
      label: Schema.optional(Schema.NullOr(Schema.String)),
      confidence: Schema.Number,
      interactive: Schema.Boolean,
      bounds: Schema.Struct({
        x: Schema.Number,
        y: Schema.Number,
        width: Schema.Number,
        height: Schema.Number,
      }),
    }),
  ),
});
const decodeVisualResult = Schema.decodeUnknownOption(VisualResultShape);

const positiveInteger = (value: number) => Number.isInteger(value) && value > 0;
const pixel = (value: number) => Number.isInteger(value) && value >= 0;
const nonempty = (value: string | null | undefined): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * Validate a `parse_visual_regions` result against the observation that
 * requested it. Mirrors jev-use `parseVisualRegions`: the schema, capture id,
 * window identity, screenshot provenance and an invertible action mapping must
 * all match, and every region must be well formed and inside its screenshot.
 * Anything else is rejected whole; no region of a mismatched result is used.
 */
export const readVisualRegions = (
  payload: unknown,
  expected: {
    readonly captureId: string;
    readonly pid: number;
    readonly windowId: number;
    /** The observation's screenshot size, when it reported one. */
    readonly width?: number | undefined;
    readonly height?: number | undefined;
  },
): VisualObservation | VisualObservationError => {
  const invalid = (detail: string) =>
    new VisualObservationError({ code: "invalid_visual_result", detail });
  const mismatch = (detail: string) =>
    new VisualObservationError({ code: "capture_mismatch", detail });
  const decoded = decodeVisualResult(payload);
  if (decoded._tag === "None") return invalid("the result does not have the visual-region shape");
  const result = decoded.value;
  if (result.schema !== "cua.visual_regions_v1") return invalid("unsupported visual region schema");
  const capture = result.capture;
  if (capture.capture_id !== expected.captureId)
    return mismatch("the result belongs to a different capture");
  if (
    capture.source.kind !== "window" ||
    capture.source.pid !== expected.pid ||
    capture.source.window_id !== expected.windowId
  )
    return mismatch("the result belongs to a different window");
  const screenshot = capture.screenshot;
  if (screenshot.mime_type !== "image/png" || !nonempty(screenshot.reference))
    return invalid("the screenshot provenance is malformed");
  if (!positiveInteger(screenshot.width) || !positiveInteger(screenshot.height))
    return invalid("the screenshot size is malformed");
  if (
    (expected.width !== undefined && expected.width !== screenshot.width) ||
    (expected.height !== undefined && expected.height !== screenshot.height)
  )
    return mismatch("the parsed screenshot differs from the observed one");
  const space = capture.action_coordinate_space;
  if (space.kind === "affine") {
    const values = [space.m11, space.m12, space.m21, space.m22, space.tx, space.ty];
    if (values.some((value) => value === undefined || !Number.isFinite(value)))
      return invalid("the action coordinate mapping is malformed");
    const [m11, m12, m21, m22] = values as [number, number, number, number, number, number];
    if (Math.abs(m11 * m22 - m12 * m21) <= Number.EPSILON)
      return invalid("the action coordinate mapping is not invertible");
  } else if (space.kind !== "screenshot_pixels") {
    return invalid("unsupported action coordinate space");
  }
  const ids = new Set<string>();
  const regions: VisualRegion[] = [];
  for (const raw of result.regions) {
    if (!nonempty(raw.id) || ids.has(raw.id)) return invalid("region ids are missing or repeated");
    ids.add(raw.id);
    if (raw.kind !== "text" && raw.kind !== "icon") return invalid("unsupported region kind");
    const { x, y, width, height } = raw.bounds;
    if (!pixel(x) || !pixel(y) || !positiveInteger(width) || !positiveInteger(height))
      return invalid("region bounds are malformed");
    if (x + width > screenshot.width || y + height > screenshot.height)
      return invalid("a region lies outside its screenshot");
    if (!Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1)
      return invalid("region confidence is malformed");
    const text = nonempty(raw.text) ? raw.text : undefined;
    const label = nonempty(raw.label) ? raw.label : undefined;
    if ((raw.kind === "text" && text === undefined) || (raw.kind === "icon" && label === undefined))
      return invalid("a region lacks the content its kind requires");
    regions.push({
      id: raw.id,
      kind: raw.kind,
      text,
      label,
      confidence: raw.confidence,
      interactive: raw.interactive,
      x,
      y,
      width,
      height,
    });
  }
  return {
    captureId: capture.capture_id,
    pid: expected.pid,
    windowId: expected.windowId,
    screenshotWidth: screenshot.width,
    screenshotHeight: screenshot.height,
    regions,
  };
};
