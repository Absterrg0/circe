import { RuntimeRequestId } from "@circe/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

describe("ComposerPendingApprovalPanel", () => {
  it("explains the decision and keeps the complete command readable in a card", () => {
    const detail = `bun run release -- ${"x".repeat(500)}\nsecond line`;
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: RuntimeRequestId.make("approval-1"),
          requestKind: "command",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail,
          responseCapability: "live",
        }}
        pendingCount={1}
        projectTitle="Circe"
      />,
    );

    expect(markup).toContain("Permission needed");
    expect(markup).toContain("in Circe");
    expect(markup).toContain('data-approval-detail="complete"');
    expect(markup).toContain('aria-label="Command"');
    expect(markup).toContain('role="group"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain(detail);
    expect(markup).toContain("max-h-20");
    expect(markup).toContain("overflow-auto");
    expect(markup).toContain("whitespace-pre");
    expect(markup).toContain("[scrollbar-width:thin]");
    expect(markup).toContain("[&amp;::-webkit-scrollbar]:h-1.5");
    expect(markup).not.toContain("truncate");
    expect(markup).not.toContain("line-clamp");
    expect(markup).toContain("rounded-[var(--radius)]");
    expect(markup).not.toContain("Command approval requested");
  });

  it("falls back to the approval kind when the provider sends an empty detail", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: RuntimeRequestId.make("approval-2"),
          requestKind: "file-read",
          responseCapability: "live" as const,
          createdAt: "2026-07-18T00:00:00.000Z",
          detail: "",
        }}
        pendingCount={1}
        projectTitle="API"
      />,
    );

    expect(markup).toContain("File read approval");
  });

  it("shows the app name and message for an MCP access request", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: RuntimeRequestId.make("approval-safari"),
          requestKind: "mcp-elicitation",
          responseCapability: "live" as const,
          createdAt: "2026-08-24T00:00:00.000Z",
          appName: "Safari",
          detail: "Allow ChatGPT to use Safari?",
        }}
        pendingCount={1}
        projectTitle="Circe"
      />,
    );

    expect(markup).toContain(">Safari<");
    expect(markup).toContain("Allow ChatGPT to use Safari?");
  });

  it("preserves the full app name and approval message", () => {
    const appName = "A".repeat(200);
    const detail = "Allow ChatGPT to access the selected application?";
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: RuntimeRequestId.make("approval-long-app-name"),
          requestKind: "mcp-elicitation",
          responseCapability: "live" as const,
          createdAt: "2026-08-24T00:00:00.000Z",
          appName,
          detail,
        }}
        pendingCount={1}
        projectTitle="Circe"
      />,
    );

    expect(markup).toContain(appName);
    expect(markup).toContain(detail);
  });
});
