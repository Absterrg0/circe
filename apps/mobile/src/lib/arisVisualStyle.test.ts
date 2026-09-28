import { describe, expect, it } from "vite-plus/test";

import { ARIS_CONTROL_RADIUS, ARIS_PANEL_RADIUS } from "./layoutMetrics";
import { MOBILE_SECTION_LABEL, MOBILE_TYPOGRAPHY } from "./typography";

describe("Circe mobile visual system", () => {
  it("uses the web geometry: 8px controls and 12px panels", () => {
    expect(ARIS_CONTROL_RADIUS).toBe(8);
    expect(ARIS_PANEL_RADIUS).toBe(12);
  });

  it("labels sections with the tracked uppercase instrument label", () => {
    expect(MOBILE_SECTION_LABEL).toMatchObject({
      fontSize: MOBILE_TYPOGRAPHY.micro.fontSize,
      lineHeight: MOBILE_TYPOGRAPHY.micro.lineHeight,
      letterSpacing: 2.2,
      textTransform: "uppercase",
      fontWeight: "500",
    });
  });
});
