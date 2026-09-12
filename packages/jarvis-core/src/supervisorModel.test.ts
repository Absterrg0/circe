import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";

import { resolveJarvisSupervisorModelSelection } from "./supervisorModel.ts";

type ProviderView = Pick<ServerProvider, "instanceId" | "driver" | "models">;

const provider = (
  instanceId: string,
  driver: string,
  slugs: ReadonlyArray<string>,
): ProviderView =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    models: slugs.map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
    })),
  }) as ProviderView;

const selection = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
  options: [],
});

const providers: ReadonlyArray<ProviderView> = [
  provider("codex", "codex", ["gpt-5.6-luna", "gpt-5.6-sol"]),
  provider("claude", "claudeAgent", ["claude-opus-5", "claude-sonnet-5"]),
  provider("cursor", "cursor", ["composer-2", "composer-1.5"]),
  provider("grok", "grok", ["grok-build"]),
];

describe("supervisor model resolution", () => {
  it("keeps the default Luna selection on Codex", () => {
    const current = selection("codex", "gpt-5.6-luna");
    expect(resolveJarvisSupervisorModelSelection({ selection: current, providers })).toBe(
      current,
    );
  });

  it("falls back to Sonnet when the Claude supervisor names another driver model", () => {
    expect(
      resolveJarvisSupervisorModelSelection({
        selection: selection("claude", "gpt-5.6-luna"),
        providers,
      }),
    ).toMatchObject({ instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-5" });
  });

  it("falls back to Composer for a mismatched Cursor supervisor", () => {
    expect(
      resolveJarvisSupervisorModelSelection({
        selection: selection("cursor", "gpt-5.6-luna"),
        providers,
      }),
    ).toMatchObject({ model: "composer-2" });
  });

  it("falls back to the simplest Grok model", () => {
    expect(
      resolveJarvisSupervisorModelSelection({
        selection: selection("grok", "gpt-5.6-luna"),
        providers,
      }),
    ).toMatchObject({ model: "grok-build" });
  });

  it("canonicalizes spoken aliases to the driver slug", () => {
    expect(
      resolveJarvisSupervisorModelSelection({ selection: selection("claude", "sonnet"), providers }),
    ).toMatchObject({ model: "claude-sonnet-5" });
    expect(
      resolveJarvisSupervisorModelSelection({
        selection: selection("cursor", "composer"),
        providers,
      }),
    ).toMatchObject({ model: "composer-2" });
  });

  it("keeps an explicit model the instance offers", () => {
    const current = selection("claude", "claude-opus-5");
    expect(resolveJarvisSupervisorModelSelection({ selection: current, providers })).toBe(
      current,
    );
  });

  it("keeps the selection when the instance is unknown", () => {
    const current = selection("custom", "gpt-5.6-luna");
    expect(resolveJarvisSupervisorModelSelection({ selection: current, providers })).toBe(
      current,
    );
  });
});
