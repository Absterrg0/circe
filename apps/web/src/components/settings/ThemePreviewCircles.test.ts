import { describe, expect, it } from "vite-plus/test";

import { STANDARD_THEME_PREVIEW_COLORS } from "@circe/shared/themePreview";

import { getStandardThemeColors, toCanonicalThemeColor } from "../../themePalette";
import { STANDARD_THEME_CARDS, previewColorsOf } from "./ThemePreviewCircles";

describe("Circe standard theme preview", () => {
  it("previews Void and Daylight with the copper action color, like mobile", () => {
    const card = STANDARD_THEME_CARDS.find((entry) => entry.id === "default");
    expect(card).toBeDefined();
    expect(card?.label).toBe("Circe");

    const light = previewColorsOf(card!, "light");
    const dark = previewColorsOf(card!, "dark");

    // The same shared source mobile previews, and the stock palette's own
    // canvas and action colors.
    expect(light).toMatchObject(STANDARD_THEME_PREVIEW_COLORS.light);
    expect(dark).toMatchObject(STANDARD_THEME_PREVIEW_COLORS.dark);
    expect(toCanonicalThemeColor(light?.canvas)).toBe(getStandardThemeColors("light").canvas);
    expect(toCanonicalThemeColor(dark?.canvas)).toBe(getStandardThemeColors("dark").canvas);
    expect(toCanonicalThemeColor(light?.messageAction)).toBe(
      getStandardThemeColors("light").messageAction,
    );
    expect(toCanonicalThemeColor(dark?.messageAction)).toBe(
      getStandardThemeColors("dark").messageAction,
    );
  });
});
