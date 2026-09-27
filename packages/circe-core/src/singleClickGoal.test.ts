import { describe, expect, it } from "vite-plus/test";

import { singleClickTarget } from "./singleClickGoal.ts";

describe("single click goal", () => {
  it("extracts the control name from a single click goal", () => {
    expect(singleClickTarget("click the 7 button in the calculator")).toBe("7");
    expect(singleClickTarget("click the Recent Files item in the file manager sidebar")).toBe(
      "recent files",
    );
    expect(singleClickTarget("press the Save button")).toBe("save");
    expect(singleClickTarget("Tap on the Wi-Fi panel.")).toBe("wi-fi panel");
  });

  it("declines goals that need more than one action or judgement", () => {
    expect(singleClickTarget("click 7, then the multiply button, then 8")).toBeUndefined();
    expect(singleClickTarget("open youtube")).toBeUndefined();
    expect(singleClickTarget("type hello into the text editor")).toBeUndefined();
    expect(singleClickTarget("click the button and close the window")).toBeUndefined();
    expect(singleClickTarget("scroll down")).toBeUndefined();
    expect(singleClickTarget("")).toBeUndefined();
  });
});
