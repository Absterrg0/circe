import { describe, expect, it } from "vite-plus/test";

import { T3CODE_MOBILE_SLUG, resolveExpoOwnership } from "./expo-ownership.ts";

describe("mobile Expo ownership", () => {
  it("does not carry upstream Expo identity into a fresh checkout", () => {
    expect(resolveExpoOwnership({})).toEqual({ slug: T3CODE_MOBILE_SLUG });
  });

  it("enables OTA only when a Circe-owned project is configured", () => {
    expect(
      resolveExpoOwnership({
        T3CODE_EXPO_OWNER: "abstergo",
        T3CODE_EXPO_PROJECT_ID: "circe-preview-project",
      }),
    ).toEqual({
      slug: T3CODE_MOBILE_SLUG,
      owner: "abstergo",
      projectId: "circe-preview-project",
      updatesUrl: "https://u.expo.dev/circe-preview-project",
    });
  });

  it("trims configured values and ignores empty values", () => {
    expect(
      resolveExpoOwnership({
        T3CODE_EXPO_OWNER: "  ",
        T3CODE_EXPO_PROJECT_ID: "  ",
      }),
    ).toEqual({ slug: T3CODE_MOBILE_SLUG });
  });
});
