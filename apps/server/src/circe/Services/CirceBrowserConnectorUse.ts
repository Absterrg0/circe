import type { CirceBrowserUseInput, CirceBrowserUseResult } from "@circe/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * Real-browser missions over the Chrome extension connector. Same result
 * contract as the preview and desktop missions so the interaction layer can
 * treat every surface uniformly.
 */
export interface CirceBrowserConnectorUseShape {
  readonly run: (input: CirceBrowserUseInput) => Effect.Effect<CirceBrowserUseResult>;
}

export class CirceBrowserConnectorUse extends Context.Service<
  CirceBrowserConnectorUse,
  CirceBrowserConnectorUseShape
>()("@absterrg0/circe/circe/Services/CirceBrowserConnectorUse") {}
