import type { CirceBrowserConnectorAction, CirceBrowserConnectorSnapshot } from "@circe/contracts";
import type { ComputerUseRuntime } from "@circe/core/computerUse";
import type { DecisionAnswers, DecisionRequest } from "@circe/core/decision";
import {
  browserOperationForAction,
  browserSurfaceFromSnapshot,
  type BrowserAutomationOperation,
} from "@circe/core/browserUse";
import * as Effect from "effect/Effect";

import type { CirceBrowserConnectorError } from "../Services/CirceBrowserConnector.ts";
import type { CirceBrowserConnectorShape } from "../Services/CirceBrowserConnector.ts";

/**
 * Adapts the browser connector to the grounded step loop. The extension's
 * element handles are the only targets: a snapshot's element id is the
 * locator, and an operation the extension no longer recognises is refused
 * rather than retried as a coordinate.
 */

/** The preview-shaped snapshot the shared surface mapper understands. */
export const previewSnapshotFromConnector = (
  snapshot: CirceBrowserConnectorSnapshot,
): {
  readonly title: string;
  readonly url: string;
  readonly visibleText: string;
  readonly interactiveElements: ReadonlyArray<{
    readonly tag: string;
    readonly role: string | null;
    readonly name: string;
    readonly selector: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly value?: string;
    readonly state?: string;
  }>;
} => ({
  title: snapshot.title,
  url: snapshot.url,
  visibleText: snapshot.visibleText,
  interactiveElements: snapshot.elements.map((element) => ({
    tag: "",
    role: element.role,
    name: element.name,
    selector: element.id,
    x: element.bounds?.x ?? 0,
    y: element.bounds?.y ?? 0,
    width: element.bounds?.width ?? 0,
    height: element.bounds?.height ?? 0,
    ...(element.value === undefined ? {} : { value: element.value }),
    ...(element.state === undefined ? {} : { state: element.state }),
  })),
});

export const connectorActionForOperation = (
  operation: BrowserAutomationOperation,
): CirceBrowserConnectorAction => {
  switch (operation.operation) {
    case "navigate":
      return { operation: "navigate", url: operation.input.url ?? "" };
    case "click":
      return { operation: "click", locator: operation.input.locator ?? "" };
    case "type":
      return {
        operation: "type",
        text: operation.input.text,
        locator: operation.input.locator ?? "",
      };
    case "press":
      return { operation: "press", key: operation.input.key };
    case "scroll":
      return {
        operation: "scroll",
        ...(operation.input.deltaX === undefined ? {} : { deltaX: operation.input.deltaX }),
        ...(operation.input.deltaY === undefined ? {} : { deltaY: operation.input.deltaY }),
      };
  }
};

export interface ConnectorUseRuntimeInput<E = never> {
  readonly connector: CirceBrowserConnectorShape;
  readonly select: (request: DecisionRequest) => Effect.Effect<DecisionAnswers, E>;
  readonly profileLabel?: string;
  readonly maxElements?: number;
}

export const makeConnectorUseRuntime = <E = never>(
  input: ConnectorUseRuntimeInput<E>,
): ComputerUseRuntime<E | CirceBrowserConnectorError> => ({
  capture: () =>
    input.connector.snapshot(input.profileLabel).pipe(
      Effect.map((snapshot) =>
        browserSurfaceFromSnapshot(previewSnapshotFromConnector(snapshot), {
          ...(input.maxElements === undefined ? {} : { maxElements: input.maxElements }),
        }),
      ),
    ),
  select: input.select,
  apply: (action) => {
    const operation = browserOperationForAction(action);
    if (operation === null) return Effect.succeed(true);
    return input.connector.apply(connectorActionForOperation(operation), input.profileLabel);
  },
});
