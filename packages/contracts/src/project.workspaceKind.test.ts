import { describe, expect, it } from "vite-plus/test";

import { isChatWorkspace } from "./project.ts";

describe("isChatWorkspace", () => {
  it("uses the workspace kind when the node sends it", () => {
    expect(isChatWorkspace({ kind: "chats", title: "Anything" })).toBe(true);
    // A user project may be named Conversations without becoming the chat space.
    expect(isChatWorkspace({ kind: "project", title: "Conversations" })).toBe(false);
  });

  it("recognizes an older node's chat space by its title only when kind is absent", () => {
    expect(isChatWorkspace({ title: "Conversations" })).toBe(true);
    expect(isChatWorkspace({ title: "Billing" })).toBe(false);
  });
});
