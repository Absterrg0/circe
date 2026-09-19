import { describe, expect, it } from "vite-plus/test";

import { readDefaultMobileThemeVariables } from "./mobileTheme.test-support";
import { getMobileThemeVariables, MOBILE_THEME_IDS, themeColorWithAlpha } from "./mobileTheme";
import { getMobileThemeRuntimeVariables } from "./mobileThemeVariables";

describe("mobile theme runtime variables", () => {
  it("derives the standard runtime palette from global.css", () => {
    expect(getMobileThemeRuntimeVariables("circe", "light", "ios")).toEqual(
      readDefaultMobileThemeVariables("light"),
    );
    expect(getMobileThemeRuntimeVariables("circe", "dark", "ios")).toEqual(
      readDefaultMobileThemeVariables("dark"),
    );
  });

  it("uses the same shared palette source as generated custom themes", () => {
    expect(getMobileThemeRuntimeVariables("ocean", "light", "ios")).toEqual(
      getMobileThemeVariables("ocean", "light"),
    );
    expect(getMobileThemeRuntimeVariables("iris", "dark", "ios")).toEqual(
      getMobileThemeVariables("iris", "dark"),
    );
  });

  it.each(MOBILE_THEME_IDS)(
    "keeps %s colors on Android with an opaque Material frame",
    (themeId) => {
      for (const appearance of ["light", "dark"] as const) {
        const ios = getMobileThemeRuntimeVariables(themeId, appearance, "ios");
        const android = getMobileThemeRuntimeVariables(themeId, appearance, "android");
        expect(android).toEqual({
          ...ios,
          "--color-header": themeColorWithAlpha(
            ios[
              themeId === "circe" || themeId === "material-you" ? "--color-card" : "--color-drawer"
            ],
            1,
          ),
        });
        expect(android["--color-header"]).toMatch(/^rgba\(\d+, \d+, \d+, 1\)$/);
      }
    },
  );

  it.each(["circe", "material-you"] as const)(
    "keeps the %s default dark frame distinct from the rounded settings body",
    (themeId) => {
      const variables = getMobileThemeRuntimeVariables(themeId, "dark", "android");
      expect(variables["--color-header"]).toBe("rgba(18, 20, 21, 1)");
      expect(variables["--color-header"]).not.toBe(
        themeColorWithAlpha(variables["--color-sheet-solid"], 1),
      );
    },
  );
});
