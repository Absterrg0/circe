import type { DecisionAnswer, DecisionAnswers } from "@circe/core/decision";
import type { ComputerSurface, ComputerUseRuntime } from "@circe/core/computerUse";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { makeDesktopUseRuntime, type DesktopActuator } from "./desktopUseRuntime.ts";

const surface: ComputerSurface = {
  kind: "desktop",
  title: "Editor",
  elements: [
    {
      id: "app:0/0/3",
      role: "push button",
      name: "Save",
      bounds: { x: 700, y: 40, width: 80, height: 24 },
    },
    {
      id: "app:0/0/5",
      role: "entry",
      name: "Search",
      bounds: { x: 100, y: 40, width: 200, height: 24 },
    },
  ],
};

const choice = (value: string): DecisionAnswer => ({
  type: "choice",
  choice: value,
  probabilities: { [value]: 0.95 },
  confidence: 0.95,
});

const selecting = (...entries: ReadonlyArray<readonly [string, DecisionAnswer]>): DecisionAnswers =>
  Object.fromEntries(entries);

const record = (): { readonly calls: Array<string>; readonly actuator: DesktopActuator } => {
  const calls: Array<string> = [];
  return {
    calls,
    actuator: {
      activate: (id) =>
        Effect.sync(() => {
          calls.push(`activate:${id}`);
          return id === "app:0/0/3";
        }),
      setText: (id, text) =>
        Effect.sync(() => {
          calls.push(`setText:${id}:${text}`);
          return id === "app:0/0/5";
        }),
      clickAt: (element) =>
        Effect.sync(() => {
          calls.push(`clickAt:${element.id}`);
        }),
      typeText: (text) =>
        Effect.sync(() => {
          calls.push(`type:${text}`);
        }),
      pressKey: (key) =>
        Effect.sync(() => {
          calls.push(`key:${key}`);
        }),
      scroll: (direction) =>
        Effect.sync(() => {
          calls.push(`scroll:${direction}`);
        }),
    },
  };
};

const runtimeWith = (actuator: DesktopActuator): ComputerUseRuntime =>
  makeDesktopUseRuntime({
    observe: () => Effect.succeed(surface),
    select: () => Effect.succeed(selecting(["action", choice("click")])),
    actuator,
  });

const apply = (runtime: ComputerUseRuntime, action: Parameters<ComputerUseRuntime["apply"]>[0]) =>
  Effect.runSync(runtime.apply(action));

describe("desktop use runtime", () => {
  it("activates an element through the accessibility action", () => {
    const { calls, actuator } = record();
    const runtime = runtimeWith(actuator);
    Effect.runSync(runtime.capture());
    apply(runtime, { kind: "click", elementId: "app:0/0/3" });
    expect(calls).toEqual(["activate:app:0/0/3"]);
  });

  it("falls back to a grounded coordinate click when activation fails", () => {
    const { calls, actuator } = record();
    const runtime = runtimeWith(actuator);
    Effect.runSync(runtime.capture());
    apply(runtime, { kind: "click", elementId: "app:0/0/5" });
    expect(calls).toEqual(["activate:app:0/0/5", "clickAt:app:0/0/5"]);
  });

  it("sets editable text directly and types otherwise", () => {
    const { calls, actuator } = record();
    const runtime = runtimeWith(actuator);
    Effect.runSync(runtime.capture());
    apply(runtime, { kind: "type", elementId: "app:0/0/5", text: "hello" });
    apply(runtime, { kind: "type", text: "tail" });
    expect(calls).toEqual(["setText:app:0/0/5:hello", "type:tail"]);
  });

  it("routes press and scroll to the keyboard and pointer", () => {
    const { calls, actuator } = record();
    const runtime = runtimeWith(actuator);
    Effect.runSync(runtime.capture());
    apply(runtime, { kind: "press", elementId: "app:0/0/3", key: "enter" });
    apply(runtime, { kind: "scroll", direction: "down" });
    expect(calls).toEqual(["clickAt:app:0/0/3", "key:enter", "scroll:down"]);
  });
});
