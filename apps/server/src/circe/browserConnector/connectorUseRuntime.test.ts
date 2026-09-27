import type { CirceBrowserConnectorSnapshot } from "@circe/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { CirceBrowserConnectorShape } from "../Services/CirceBrowserConnector.ts";

import {
  connectorActionForOperation,
  makeConnectorUseRuntime,
  previewSnapshotFromConnector,
} from "./connectorUseRuntime.ts";

const snapshot: CirceBrowserConnectorSnapshot = {
  tabId: "7",
  title: "Inbox",
  url: "https://mail.example.com",
  visibleText: "Compose",
  elements: [
    {
      id: "ax:42",
      role: "button",
      name: "Compose",
      editable: false,
      bounds: { x: 10, y: 20, width: 30, height: 12 },
    },
    { id: "ax:43", role: "textbox", name: "Search", editable: true },
  ],
};

const connector = (input: {
  readonly applied: Array<unknown>;
  readonly ok?: boolean;
}): CirceBrowserConnectorShape => ({
  status: () => Effect.succeed({ connected: true }),
  listTabs: () => Effect.succeed([]),
  attach: () => Effect.die("unused"),
  snapshot: () => Effect.succeed(snapshot),
  apply: (action) =>
    Effect.sync(() => {
      input.applied.push(action);
      return input.ok ?? true;
    }),
});

describe("connector use runtime", () => {
  it("maps a connector snapshot into the grounded browser surface", () => {
    const preview = previewSnapshotFromConnector(snapshot);
    assert.deepStrictEqual(preview.interactiveElements[0], {
      tag: "",
      role: "button",
      name: "Compose",
      selector: "ax:42",
      x: 10,
      y: 20,
      width: 30,
      height: 12,
    });
  });

  it.effect("captures the connector surface and returns the action result", () =>
    Effect.gen(function* () {
      const applied: Array<unknown> = [];
      const runtime = makeConnectorUseRuntime({
        connector: connector({ applied }),
        select: () => Effect.die("unused"),
      });
      const surface = yield* runtime.capture();
      assert.strictEqual(surface.kind, "browser");
      assert.deepStrictEqual(
        surface.elements.map((element) => element.id),
        ["ax:42", "ax:43"],
      );
      const ok = yield* runtime.apply({ kind: "click", elementId: "ax:42" });
      assert.strictEqual(ok, true);
      assert.deepStrictEqual(applied, [{ operation: "click", locator: "ax:42" }]);
    }),
  );

  it.effect("propagates a refused action instead of claiming it applied", () =>
    Effect.gen(function* () {
      const applied: Array<unknown> = [];
      const runtime = makeConnectorUseRuntime({
        connector: connector({ applied, ok: false }),
        select: () => Effect.die("unused"),
      });
      const ok = yield* runtime.apply({ kind: "type", elementId: "ax:43", text: "hello" });
      assert.strictEqual(ok, false);
      assert.deepStrictEqual(applied, [{ operation: "type", text: "hello", locator: "ax:43" }]);
    }),
  );

  it("translates every grounded action to one connector operation", () => {
    assert.deepStrictEqual(
      connectorActionForOperation({ operation: "press", input: { key: "Enter" } }),
      { operation: "press", key: "Enter" },
    );
    assert.deepStrictEqual(
      connectorActionForOperation({ operation: "scroll", input: { deltaY: 600 } }),
      { operation: "scroll", deltaY: 600 },
    );
  });
});
