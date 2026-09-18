import { describe, expect, it } from "vite-plus/test";

import { modelSupportsImageInput } from "./modelVision.ts";

describe("model image input", () => {
  it("recognizes current multimodal families", () => {
    expect(modelSupportsImageInput("claude-sonnet-5")).toBe(true);
    expect(modelSupportsImageInput("claude-opus-4.8")).toBe(true);
    expect(modelSupportsImageInput("gpt-5.6-sol")).toBe(true);
    expect(modelSupportsImageInput("gemini-3.7-flash")).toBe(true);
    expect(modelSupportsImageInput("grok-4.6")).toBe(true);
  });

  it("treats codex command models and unknown ids as text-only", () => {
    expect(modelSupportsImageInput("gpt-5.3-codex")).toBe(false);
    expect(modelSupportsImageInput("some-local-model")).toBe(false);
    expect(modelSupportsImageInput("")).toBe(false);
  });
});
