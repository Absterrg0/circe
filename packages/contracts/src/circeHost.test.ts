import { describe, expect, it } from "vite-plus/test";

import { circeHostNoticeReaches } from "./circeHost.ts";

describe("circeHostNoticeReaches", () => {
  it("brings news about a device's work to that device only", () => {
    const notice = { id: "n", text: '"Parser" is done.', audience: ["desk"] };
    expect(circeHostNoticeReaches(notice, "desk")).toBe(true);
    expect(circeHostNoticeReaches(notice, "phone")).toBe(false);
  });

  it("brings news about work no device sent to every device", () => {
    const notice = { id: "n", text: '"Parser" needs your approval.' };
    expect(circeHostNoticeReaches(notice, "desk")).toBe(true);
    expect(circeHostNoticeReaches(notice, "phone")).toBe(true);
  });
});
