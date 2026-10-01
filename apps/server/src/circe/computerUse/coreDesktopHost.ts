import type { ComputerHostToolResult } from "@circe/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { CuaPlatform } from "../../computer/cuaObservation.ts";
import {
  readApps,
  readLaunchPid,
  readWindows,
  type CuaWindow,
} from "../../computer/driverSchemas.ts";
import {
  CAPTURE_REFUSAL_CODES,
  clickArguments,
  observeGrounded,
  type GroundedObservation,
} from "../../computer/grounding.ts";
import type {
  DesktopAction,
  DesktopApp,
  DesktopHost,
  DesktopReceipt,
  DesktopView,
  DesktopWindow,
} from "../host/core.ts";

/**
 * This node's desktop as circe-core's desktop executor sees it. Every call
 * goes through one computer mission, so it is audited, stoppable and owned
 * exactly like any other use of the computer. circe-core only ever holds the
 * ids handed out here: process ids, window ids, accessibility tokens and
 * screen coordinates stay on this side.
 *
 * An observation authorizes actions until the next action or observation of
 * any window; an action on an older one is not delivered. A point read from a
 * screen capture is clicked at most once, bound to that capture.
 */

export interface CoreDesktopHostInput<E> {
  /** One driver call inside the mission. */
  readonly call: (
    tool: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<ComputerHostToolResult, E>;
  readonly platform: CuaPlatform;
  /** Read per observation: screen reading may become available during the mission. */
  readonly visualAvailable: Effect.Effect<boolean>;
  /**
   * Checked immediately before every input: once it is true nothing more is
   * sent, and `onStopped` tells circe-core to stop.
   */
  readonly stopped?: Effect.Effect<boolean>;
  readonly onStopped?: () => void;
  /** Runs one host operation; a failure rejects with the typed error. */
  readonly run: <A, X>(effect: Effect.Effect<A, X>) => Promise<A>;
}

/** An observation circe-core cannot use: an unknown window, or one with nothing to act on. */
export class DesktopHostError extends Schema.TaggedError<DesktopHostError>()("DesktopHostError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

const WINDOW_WAIT_MS = 15_000;
const WINDOW_POLL_MS = 250;
const SCROLL_LINES = 5;

const fold = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

interface Target {
  readonly pid: number;
  readonly windowId: number;
}

interface Installed {
  readonly name: string;
  readonly launchPath?: string;
  readonly bundleId?: string;
}

/** How one driver result reads as delivery. Only a refusal before any input is safe to look past. */
export function receiptOf(result: ComputerHostToolResult): DesktopReceipt {
  const detail = result.text.length > 0 ? result.text.slice(0, 300) : undefined;
  const withDetail = (delivery: DesktopReceipt["delivery"]): DesktopReceipt =>
    detail === undefined ? { delivery } : { delivery, detail };
  switch (result.effect) {
    case "verified":
      return withDetail(result.isError ? "not-delivered" : "confirmed");
    case "dispatched-unknown":
      return withDetail(result.isError ? "unknown" : "delivered");
    case "refused":
    case "not-dispatched":
      return withDetail("not-delivered");
  }
}

export function makeCoreDesktopHost<E>(input: CoreDesktopHostInput<E>): DesktopHost {
  const { call, run } = input;
  const windows = new Map<string, Target>();
  const installed = new Map<string, Installed>();
  let latest: { readonly ref: string; readonly observation: GroundedObservation } | undefined;
  let sequence = 0;
  const consumedCaptures = new Set<string>();

  const windowOf = (window: CuaWindow): DesktopWindow => {
    const id = `${window.pid}:${Math.trunc(window.window_id)}`;
    windows.set(id, { pid: window.pid, windowId: Math.trunc(window.window_id) });
    return { id, app: window.app_name, title: window.title };
  };

  const listWindows = Effect.gen(function* () {
    const result = yield* call("list_windows", { on_screen_only: true });
    return result.isError
      ? []
      : readWindows(result.structured).filter((window) => window.is_on_screen !== false);
  });

  const frontmostFirst = (list: ReadonlyArray<CuaWindow>) =>
    [...list].sort((a, b) => (b.z_index ?? 0) - (a.z_index ?? 0));

  const apps = (): Promise<ReadonlyArray<DesktopApp>> =>
    run(
      Effect.gen(function* () {
        const [appsResult, onScreen] = yield* Effect.all([call("list_apps", {}), listWindows]);
        const listedApps = appsResult.isError ? [] : readApps(appsResult.structured);
        const processNames = new Map(
          listedApps.filter((app) => app.running && app.pid > 0).map((app) => [app.pid, app.name]),
        );
        const entries = listedApps.filter((app) =>
          input.platform === "linux"
            ? app.kind === "desktop" || !!app.launch_path || (app.windows?.length ?? 0) > 0
            : !!app.launch_path || !!app.bundle_id,
        );
        // The names one installed app goes by: its own, its launch command's
        // program, and the last part of its bundle id ("org.gnome.Calculator").
        const entryKeys = (app: (typeof entries)[number]) =>
          new Set(
            [
              app.name,
              app.launch_path?.trim().split(/\s+/u)[0]?.split("/").pop(),
              app.bundle_id?.split(".").pop(),
            ]
              .filter((key): key is string => key !== undefined && key.length > 0)
              .map(fold),
          );
        // A running app is its windows, named as the user knows it: a window
        // that reports its process name ("gnome-calculator") is the installed
        // app of that name, so the app is reused rather than launched again.
        const byPid = new Map<number, CuaWindow[]>();
        for (const window of frontmostFirst(onScreen)) {
          byPid.set(window.pid, [...(byPid.get(window.pid) ?? []), window]);
        }
        const claimed = new Set<(typeof entries)[number]>();
        const running: DesktopApp[] = [...byPid.entries()].map(([pid, list]) => {
          const keys = [list[0]!.app_name, processNames.get(pid)]
            .filter((key): key is string => key !== undefined)
            .map(fold);
          const entry = entries.find((candidate) => {
            const known = entryKeys(candidate);
            return keys.some((key) => known.has(key));
          });
          const id = `pid:${pid}`;
          if (entry !== undefined) {
            claimed.add(entry);
            installed.set(id, {
              name: entry.name,
              ...(entry.launch_path ? { launchPath: entry.launch_path } : {}),
              ...(entry.bundle_id ? { bundleId: entry.bundle_id } : {}),
            });
          }
          return {
            id,
            name: entry?.name ?? list[0]!.app_name,
            running: true,
            windows: list.map((window) => ({
              ...windowOf(window),
              app: entry?.name ?? window.app_name,
            })),
          };
        });
        const runningNames = new Set(running.map((app) => fold(app.name)));
        const catalog: DesktopApp[] = [];
        const listed = new Set<string>();
        for (const app of entries) {
          if (claimed.has(app) || runningNames.has(fold(app.name))) continue;
          const id = `app:${app.bundle_id ?? app.launch_path ?? app.name}`;
          if (listed.has(id)) continue;
          listed.add(id);
          installed.set(id, {
            name: app.name,
            ...(app.launch_path ? { launchPath: app.launch_path } : {}),
            ...(app.bundle_id ? { bundleId: app.bundle_id } : {}),
          });
          catalog.push({ id, name: app.name, running: false, windows: [] });
        }
        return [...running, ...catalog];
      }),
    );

  /** The last gate before input reaches the OS. */
  const halted = Effect.gen(function* () {
    if (input.stopped === undefined || !(yield* input.stopped)) return false;
    input.onStopped?.();
    return true;
  });
  const HALTED = { delivery: "not-delivered", detail: "the goal was stopped" } as const;

  const launch = (app: DesktopApp) =>
    run(
      Effect.gen(function* () {
        if (yield* halted) return { receipt: HALTED };
        const entry = installed.get(app.id) ?? { name: app.name };
        const before = new Set(
          (yield* listWindows).map((window) => `${window.pid}:${window.window_id}`),
        );
        const result = yield* call("launch_app", {
          ...(entry.launchPath !== undefined
            ? { launch_path: entry.launchPath }
            : entry.bundleId !== undefined
              ? { bundle_id: entry.bundleId }
              : { name: entry.name }),
        });
        const receipt = receiptOf(result);
        if (receipt.delivery === "unknown") return { receipt };
        const pid = readLaunchPid(result.structured);
        // The launched process's window, or a new window of the same app
        // when the launcher handed off to a running instance. A cold launch
        // can report failure while the process is still starting (Text Editor
        // appeared ~13s after a launch failure), so a window is awaited even
        // on a not-delivered receipt; only an unknown delivery stops outright.
        const pick = (list: ReadonlyArray<CuaWindow>) =>
          frontmostFirst(list).find((window) => pid !== undefined && window.pid === pid) ??
          frontmostFirst(list).find(
            (window) =>
              !before.has(`${window.pid}:${window.window_id}`) &&
              fold(window.app_name) === fold(entry.name),
          );
        let found = pick(readWindows(result.structured));
        const deadline = (yield* Clock.currentTimeMillis) + WINDOW_WAIT_MS;
        while (found === undefined && (yield* Clock.currentTimeMillis) < deadline) {
          yield* Effect.sleep(WINDOW_POLL_MS);
          found = pick(yield* listWindows);
        }
        if (found !== undefined)
          return {
            receipt:
              receipt.delivery === "not-delivered"
                ? { delivery: "delivered" as const, detail: "the window appeared after launch" }
                : receipt,
            window: { ...windowOf(found), app: entry.name },
          };
        return { receipt };
      }),
    );

  const observe = (window: DesktopWindow, options?: { readonly closer?: boolean }) =>
    run(
      Effect.gen(function* () {
        const target = windows.get(window.id);
        if (target === undefined)
          return yield* new DesktopHostError({ reason: `unknown window ${window.id}` });
        const observation = yield* observeGrounded({
          call,
          target,
          platform: input.platform,
          visualAvailable: yield* input.visualAvailable,
          mode: options?.closer === true ? "visual" : "auto",
          app: window.app,
        });
        yield* Effect.logInfo("desktop observation", {
          windowId: window.id,
          ...observation.report,
        });
        const reachable = observation.elements.filter(
          (element) => element.role !== "window" && element.role !== "frame",
        );
        if (reachable.length === 0 && observation.report.visual === "unavailable")
          return yield* new DesktopHostError({
            reason: `${window.app} does not expose its controls to accessibility, and reading the screen is unavailable on this computer.`,
          });
        sequence += 1;
        const ref = `o${sequence}`;
        latest = { ref, observation };
        const view: DesktopView = {
          window: { ...window, title: observation.title ?? window.title },
          ref,
          title: observation.title ?? window.title,
          ...(observation.text === undefined ? {} : { text: observation.text }),
          ...(observation.degraded ? { partial: true } : {}),
          controls: observation.elements.map((element) => {
            const parts = element.state?.split(",") ?? [];
            const activatable = parts.some(
              (part) =>
                part.startsWith("actions:") &&
                part
                  .slice(8)
                  .split("|")
                  .some((action) => ["click", "activate", "invoke", "press"].includes(action)),
            );
            const state = [
              ...parts.filter((part) => !part.startsWith("actions:")),
              ...(activatable ? ["activatable"] : []),
            ].join(",");
            return {
              id: element.id,
              role: element.role,
              name: element.name,
              source: element.source ?? "native",
              ...(element.description === undefined ? {} : { description: element.description }),
              ...(element.value === undefined ? {} : { value: element.value }),
              ...(state === undefined || state.length === 0 ? {} : { state }),
              ...(element.editable === undefined ? {} : { editable: element.editable }),
            };
          }),
        };
        return view;
      }),
    );

  const act = (view: DesktopView, action: DesktopAction): Promise<DesktopReceipt> =>
    run(
      Effect.gen(function* () {
        const current = latest;
        if (current === undefined || current.ref !== view.ref)
          return {
            delivery: "not-delivered",
            detail: "that observation is no longer current",
          } as const;
        // Any action retires the observation it was chosen from.
        latest = undefined;
        if (yield* halted) return HALTED;
        const target = current.observation.target;
        const executableOf = (control: string) => current.observation.executables.get(control);
        switch (action.kind) {
          case "click": {
            const executable = executableOf(action.control);
            if (executable === undefined)
              return { delivery: "not-delivered", detail: "no such control" } as const;
            if (executable.kind === "visual") {
              if (consumedCaptures.has(executable.captureId))
                return {
                  delivery: "not-delivered",
                  detail: "that capture already authorized a click",
                } as const;
              consumedCaptures.add(executable.captureId);
            }
            const result = yield* call("click", clickArguments(target, executable, "background"));
            return stale(result) ?? receiptOf(result);
          }
          case "type": {
            const executable = executableOf(action.control);
            if (executable?.kind !== "native")
              return {
                delivery: "not-delivered",
                detail: "only a native field takes text",
              } as const;
            const result = yield* call("set_value", {
              pid: target.pid,
              window_id: target.windowId,
              element_token: executable.token,
              value: action.text,
              delivery_mode: "background",
            });
            return stale(result) ?? receiptOf(result);
          }
          case "key": {
            const executable = executableOf(action.control);
            if (executable?.kind !== "native")
              return { delivery: "not-delivered", detail: "keys go to a native control" } as const;
            const result = yield* call("press_key", {
              pid: target.pid,
              window_id: target.windowId,
              element_token: executable.token,
              key: action.key,
              delivery_mode: "background",
            });
            return stale(result) ?? receiptOf(result);
          }
          case "scroll": {
            const result = yield* call("scroll", {
              pid: target.pid,
              window_id: target.windowId,
              direction: action.direction,
              amount: SCROLL_LINES,
              by: "line",
              delivery_mode: "background",
            });
            return receiptOf(result);
          }
        }
      }),
    );

  return { apps, launch, observe, act };
}

/** A token or capture the driver refused before any input: look again, never retry the old address. */
const stale = (result: ComputerHostToolResult): DesktopReceipt | undefined => {
  const code = result.driverCode;
  if (
    (result.effect === "refused" || result.effect === "not-dispatched") &&
    code !== undefined &&
    (CAPTURE_REFUSAL_CODES.has(code) || code === "stale_element_token")
  )
    return { delivery: "not-delivered", detail: code };
  return undefined;
};
