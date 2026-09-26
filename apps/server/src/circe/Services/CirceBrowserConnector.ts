import type {
  CirceBrowserConnectorAction,
  CirceBrowserConnectorSnapshot,
  CirceBrowserConnectorStatus,
  CirceBrowserConnectorTab,
} from "@circe/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * The node's connection to a Chrome extension in the user's own browser
 * profile. Observation and actions are scoped to the attached tab; the node
 * never opens a public debugging port and never reads a tab the user did not
 * hand it.
 */
export interface CirceBrowserConnectorShape {
  readonly status: (profileLabel?: string) => Effect.Effect<CirceBrowserConnectorStatus>;
  readonly listTabs: (
    profileLabel?: string,
  ) => Effect.Effect<ReadonlyArray<CirceBrowserConnectorTab>, CirceBrowserConnectorError>;
  readonly attach: (input: {
    readonly tabId: string;
    readonly profileLabel?: string;
  }) => Effect.Effect<
    { readonly tabId: string; readonly profileLabel: string },
    CirceBrowserConnectorError
  >;
  readonly snapshot: (
    profileLabel?: string,
  ) => Effect.Effect<CirceBrowserConnectorSnapshot, CirceBrowserConnectorError>;
  readonly apply: (
    action: CirceBrowserConnectorAction,
    profileLabel?: string,
  ) => Effect.Effect<boolean, CirceBrowserConnectorError>;
}

export class CirceBrowserConnector extends Context.Service<
  CirceBrowserConnector,
  CirceBrowserConnectorShape
>()("@absterrg0/circe/circe/Services/CirceBrowserConnector") {}

export class CirceBrowserConnectorError extends Schema.TaggedError<CirceBrowserConnectorError>()(
  "CirceBrowserConnectorError",
  { message: Schema.String },
) {}
