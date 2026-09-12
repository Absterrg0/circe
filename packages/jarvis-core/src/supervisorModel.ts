import {
  DEFAULT_JARVIS_SUPERVISOR_MODEL_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";

type SupervisorProviderView = Pick<ServerProvider, "instanceId" | "driver" | "models">;

/**
 * Resolve the model the semantic supervisor actually calls. An explicit
 * model the instance offers (by slug, short name, or known alias) is kept
 * verbatim; a model the instance cannot serve — such as a leftover default
 * from another driver — falls back to the simplest model for that driver's
 * family (Luna, Sonnet, Composer, and so on). An unknown instance or driver
 * keeps the configured selection so availability reporting downstream stays
 * honest instead of inventing a model.
 */
export function resolveJarvisSupervisorModelSelection(input: {
  readonly selection: ModelSelection;
  readonly providers: ReadonlyArray<SupervisorProviderView>;
}): ModelSelection {
  const provider = input.providers.find(
    (candidate) => candidate.instanceId === input.selection.instanceId,
  );
  if (provider === undefined) return input.selection;
  const current = input.selection.model.trim();
  if (
    provider.models.some(
      (model) => model.slug === current || model.shortName === current,
    )
  ) {
    return input.selection;
  }
  const aliases: Readonly<Record<string, string>> =
    MODEL_SLUG_ALIASES_BY_PROVIDER[provider.driver] ?? {};
  const aliased = aliases[current.toLocaleLowerCase("en-US")];
  if (aliased !== undefined) {
    return aliased === input.selection.model
      ? input.selection
      : { ...input.selection, model: aliased };
  }
  const simplest = DEFAULT_JARVIS_SUPERVISOR_MODEL_BY_PROVIDER[provider.driver];
  if (simplest === undefined || simplest === input.selection.model) return input.selection;
  return { ...input.selection, model: simplest };
}
