import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  TextGenerationError,
  ProjectId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { JarvisCommandContext } from "@t3tools/jarvis-core/command";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { JarvisControllerInterpreter } from "../Services/JarvisController.ts";
import { makeJarvisControllerInterpreterLive } from "./JarvisController.ts";

const context: JarvisCommandContext = {
  utterance: "Testing the microphone.",
  projects: [],
  aliases: [],
  tasks: [],
  providers: [],
  supervisorModelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6-luna",
    options: [],
  },
  continueContext: false,
  inputMode: "voice",
};

function interpreterWithGeneration(generation: unknown) {
  const registry = {
    getTextGenerationForInstance: () => Effect.succeed(generation),
  };
  return makeJarvisControllerInterpreterLive(Layer.succeed(ProviderRegistry, registry as never));
}

function runInterpret(
  layer: Layer.Layer<JarvisControllerInterpreter, never, FileSystem.FileSystem>,
) {
  return Effect.runPromise(
    Effect.flatMap(JarvisControllerInterpreter, (interpreter) =>
      interpreter.interpret(context),
    ).pipe(Effect.provide(layer), Effect.provide(NodeServices.layer)),
  );
}

describe("Jarvis controller interpreter fallback", () => {
  it.effect.each(["What's the status of Authentication?", "List projects."])(
    "answers the exact read-only command %s without a provider round trip",
    (utterance) =>
      Effect.gen(function* () {
        let generationCalls = 0;
        const layer = interpreterWithGeneration({
          generateStructured: () => {
            generationCalls += 1;
            return Effect.fail(
              new TextGenerationError({
                operation: "generateStructured",
                detail: "Provider must not be needed.",
              }),
            );
          },
        });
        const result = yield* Effect.flatMap(JarvisControllerInterpreter, (interpreter) =>
          interpreter.interpret({
            ...context,
            utterance,
            recentCommandTasks: [
              {
                threadId: ThreadId.make("authentication"),
                projectId: ProjectId.make("jarvis"),
                projectTitle: "Jarvis",
                title: "Authentication",
                objective: "Fix authentication",
                state: "running",
              },
            ],
          }),
        ).pipe(Effect.provide(layer), Effect.provide(NodeServices.layer));
        expect(result).toMatchObject({
          status: "command",
          command: { type: utterance === "List projects." ? "list-projects" : "status" },
        });
        expect(generationCalls).toBe(0);
      }),
  );

  it("names the supervisor refusal when the provider hits its usage limit", async () => {
    const layer = interpreterWithGeneration({
      generateStructured: () =>
        Effect.fail(
          new TextGenerationError({
            operation: "generateStructured",
            detail: "Codex CLI command failed: ERROR: You've hit your usage limit.",
          }),
        ),
    });
    const result = await runInterpret(layer);
    expect(result).toMatchObject({
      status: "needs-input",
      reason: "unsupported-command",
      prompt:
        "The codex supervisor refused the request (usage limit or sign-in). Check the provider and try again.",
      choices: [],
    });
  });

  it("keeps the generic prompt when the supervisor instance is unavailable", async () => {
    const registry = {
      getTextGenerationForInstance: () => Effect.succeed(undefined),
    };
    const layer = makeJarvisControllerInterpreterLive(
      Layer.succeed(ProviderRegistry, registry as never),
    );
    const result = await runInterpret(layer);
    expect(result).toMatchObject({
      status: "needs-input",
      reason: "unsupported-command",
      prompt:
        "Jarvis couldn't interpret that request safely. Check the semantic supervisor and try again.",
    });
  });

  it("keeps the generic prompt for non-refusal generation failures", async () => {
    const layer = interpreterWithGeneration({
      generateStructured: () =>
        Effect.fail(
          new TextGenerationError({
            operation: "generateStructured",
            detail: "transient provider boom",
          }),
        ),
    });
    const result = await runInterpret(layer);
    expect(result).toMatchObject({
      status: "needs-input",
      reason: "unsupported-command",
      prompt:
        "Jarvis couldn't interpret that request safely. Check the semantic supervisor and try again.",
    });
  });

  it("runs a mismatched Claude supervisor on Sonnet", async () => {
    const seen: Array<unknown> = [];
    const claude = {
      instanceId: ProviderInstanceId.make("claude"),
      driver: ProviderDriverKind.make("claudeAgent"),
      models: [
        { slug: "claude-opus-5", name: "Opus", isCustom: false, capabilities: null },
        { slug: "claude-sonnet-5", name: "Sonnet", isCustom: false, capabilities: null },
      ],
    } as unknown as ServerProvider;
    const layer = interpreterWithGeneration({
      generateStructured: (args: { readonly modelSelection: { readonly model: string } }) => {
        seen.push(args.modelSelection);
        return Effect.fail(
          new TextGenerationError({
            operation: "generateStructured",
            detail: "transient provider boom",
          }),
        );
      },
    });
    const claudeContext: JarvisCommandContext = {
      ...context,
      providers: [claude],
      supervisorModelSelection: {
        instanceId: ProviderInstanceId.make("claude"),
        model: "gpt-5.6-luna",
        options: [],
      },
    };
    const result = await Effect.runPromise(
      Effect.flatMap(JarvisControllerInterpreter, (interpreter) =>
        interpreter.interpret(claudeContext),
      ).pipe(Effect.provide(layer), Effect.provide(NodeServices.layer)),
    );
    expect(seen).toEqual([
      expect.objectContaining({
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-sonnet-5",
      }),
    ]);
    expect(result).toMatchObject({ status: "needs-input", reason: "unsupported-command" });
  });
});
