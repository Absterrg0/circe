import { describe, expect, it, vi } from "vite-plus/test";

import {
  circeClientActionBooleanArg,
  circeClientActionSpeech,
  circeClientActionTextArg,
  runCirceClientAction,
} from "./clientActions.ts";

describe("runCirceClientAction", () => {
  it("runs the executor for the classified tool and keeps its result", async () => {
    const executor = vi.fn(() => ({ status: "ok" as const, speech: "Opened YouTube." }));
    const result = await runCirceClientAction({
      tool: "open-website",
      args: { website: "youtube" },
      executors: { "open-website": executor },
    });
    expect(result).toEqual({ status: "ok", speech: "Opened YouTube." });
    expect(executor).toHaveBeenCalledWith({ website: "youtube" });
  });

  it("reports a missing executor as a wiring failure naming the tool", async () => {
    const result = await runCirceClientAction({
      tool: "open-app",
      args: { app: "Spotify" },
      executors: {},
    });
    expect(result).toEqual({
      status: "failed",
      speech: "The open-app action has no executor on this client.",
    });
  });

  it("converts a throwing executor into a typed failure instead of dropping the turn", async () => {
    const result = await runCirceClientAction({
      tool: "clipboard",
      args: { action: "copy" },
      executors: {
        clipboard: () => {
          throw new Error("permission denied");
        },
      },
    });
    expect(result).toEqual({
      status: "failed",
      speech: "The clipboard action didn't finish.",
    });
  });
});

describe("circeClientActionSpeech", () => {
  it("prefers the real result speech", () => {
    expect(
      circeClientActionSpeech({
        acceptance: "Opening YouTube.",
        result: { status: "ok", speech: "YouTube is open." },
      }),
    ).toBe("YouTube is open.");
  });

  it("falls back to acceptance copy when the executor has no result speech", () => {
    expect(
      circeClientActionSpeech({
        acceptance: "Opening YouTube.",
        result: { status: "ok" },
      }),
    ).toBe("Opening YouTube.");
  });

  it("uses the failure speech when the action failed", () => {
    expect(
      circeClientActionSpeech({
        acceptance: "Opening YouTube.",
        result: { status: "failed", speech: "The launcher refused." },
      }),
    ).toBe("The launcher refused.");
  });
});

describe("client action argument readers", () => {
  it("trims text arguments and treats blanks as absent", () => {
    expect(circeClientActionTextArg({ website: "  youtube  " }, "website")).toBe("youtube");
    expect(circeClientActionTextArg({ website: "   " }, "website")).toBeUndefined();
    expect(circeClientActionTextArg({}, "website")).toBeUndefined();
  });

  it("reads booleans and ignores non-boolean values", () => {
    expect(circeClientActionBooleanArg({ muted: true }, "muted")).toBe(true);
    expect(circeClientActionBooleanArg({ muted: "true" }, "muted")).toBeUndefined();
    expect(circeClientActionBooleanArg({}, "muted")).toBeUndefined();
  });
});
