import { ProjectId } from "@t3tools/contracts";
import { isJarvisClarificationDiscard } from "@t3tools/jarvis-core/clarification";
import { describe, expect, it } from "vite-plus/test";

import {
  jarvisSupervisorFallbackPrompt,
  ordinalTaskChoice,
  projectClarificationChoiceIndex,
} from "./controllerHelpers.ts";

const jarvisId = ProjectId.make("project-jarvis");
const betaId = ProjectId.make("project-beta");

const projects = [
  { id: jarvisId, title: "Jarvis" },
  { id: betaId, title: "Beta" },
];

const candidates = [
  { projectId: jarvisId, label: "Jarvis — laptop" },
  { projectId: betaId, label: "Beta — laptop" },
] as const;

describe("server clarification callers", () => {
  it("delegates task ordinals to the shared parser, keeping first-one and option grammar", () => {
    expect(ordinalTaskChoice("first one")).toBe(0);
    expect(ordinalTaskChoice("the second one")).toBe(1);
    expect(ordinalTaskChoice("option 2")).toBe(1);
    expect(ordinalTaskChoice("number one")).toBe(0);
    expect(ordinalTaskChoice("1st")).toBe(0);
    expect(ordinalTaskChoice("rivvl")).toBeUndefined();
  });

  it("resolves a pending project by spoken word against live catalog names", () => {
    expect(
      projectClarificationChoiceIndex({ candidates: [...candidates], projects, answer: "two" }),
    ).toBe(1);
    expect(
      projectClarificationChoiceIndex({ candidates: [...candidates], projects, answer: "second" }),
    ).toBe(1);
    expect(
      projectClarificationChoiceIndex({
        candidates: [...candidates],
        projects,
        answer: "option 2",
      }),
    ).toBe(1);
  });

  it("strips a possessive against live catalog names", () => {
    expect(
      projectClarificationChoiceIndex({ candidates: [...candidates], projects, answer: "Beta's" }),
    ).toBe(1);
  });

  it("resolves heard ordinals and duplicate Rivvl names", () => {
    const rivvlA = ProjectId.make("project-rivvl-a");
    const rivvlB = ProjectId.make("project-rivvl-b");
    const rivvlProjects = [
      { id: rivvlA, title: "Rivvl" },
      { id: rivvlB, title: "Rivvl" },
    ];
    const rivvlCandidates = [
      { projectId: rivvlA, label: "Rivvl — Laptop" },
      { projectId: rivvlB, label: "Rivvl — Desktop" },
    ] as const;
    expect(
      projectClarificationChoiceIndex({
        candidates: [...rivvlCandidates],
        projects: rivvlProjects,
        answer: "one",
      }),
    ).toBe(0);
    expect(
      projectClarificationChoiceIndex({
        candidates: [...rivvlCandidates],
        projects: rivvlProjects,
        answer: "won",
      }),
    ).toBe(0);
    expect(
      projectClarificationChoiceIndex({
        candidates: [...rivvlCandidates],
        projects: rivvlProjects,
        answer: "Rivvl",
      }),
    ).toBeUndefined();
    expect(
      projectClarificationChoiceIndex({
        candidates: [...rivvlCandidates],
        projects: rivvlProjects,
        answer: "Rivvl — Desktop",
      }),
    ).toBe(1);
  });

  it("matches a repository name behind a differing title", () => {
    const appId = ProjectId.make("project-app");
    const otherId = ProjectId.make("project-other");
    const repoProjects = [
      {
        id: appId,
        title: "My App",
        workspaceRoot: "/home/user/rivvl",
        repositoryIdentity: { name: "rivvl", displayName: null },
      },
      { id: otherId, title: "Other" },
    ];
    const repoCandidates = [
      { projectId: appId, label: "My App — Laptop" },
      { projectId: otherId, label: "Other — Laptop" },
    ] as const;
    expect(
      projectClarificationChoiceIndex({
        candidates: [...repoCandidates],
        projects: repoProjects,
        answer: "rivvl",
      }),
    ).toBe(0);
  });

  it("bounds ordinals instead of falling back to a matching live name", () => {
    const numberedProjects = [
      { id: jarvisId, title: "Two" },
      { id: betaId, title: "Three" },
    ];
    const numberedCandidates = [
      { projectId: jarvisId, label: "Two — laptop" },
      { projectId: betaId, label: "Three — laptop" },
    ] as const;
    // "three" is position 3 (out of range for two candidates) and also names
    // the second live project. Bounds win: the frame stays pending.
    expect(
      projectClarificationChoiceIndex({
        candidates: [...numberedCandidates],
        projects: numberedProjects,
        answer: "three",
      }),
    ).toBeUndefined();
  });

  it("names the supervisor refusal on quota exhaustion", () => {
    expect(
      jarvisSupervisorFallbackPrompt({
        instanceId: "codex",
        cause: new Error("Codex CLI command failed: ERROR: You've hit your usage limit."),
      }),
    ).toBe(
      "The codex supervisor refused the request (usage limit or sign-in). Check the provider and try again.",
    );
  });

  it.each(["sign-in expired", "401 Unauthorized", "rate limit exceeded"])(
    "names auth and rate failures too: %s",
    (detail) => {
      expect(
        jarvisSupervisorFallbackPrompt({ instanceId: "claude", cause: new Error(detail) }),
      ).toMatch(/claude supervisor refused/);
    },
  );

  it("keeps the generic prompt for non-refusal failures", () => {
    expect(
      jarvisSupervisorFallbackPrompt({
        instanceId: "codex",
        cause: new Error("Semantic supervisor provider instance is unavailable."),
      }),
    ).toBe("Jarvis couldn't interpret that request safely. Check the semantic supervisor and try again.");
  });

  it.each(["cancel", "none", "never mind", "no"])(
    "cancels the pending frame on alias: %s",
    (answer) => {
      expect(isJarvisClarificationDiscard(answer)).toBe(true);
    },
  );

  it.each(["Beta", "two", "Beta's"])("keeps answers that select: %s", (answer) => {
    expect(isJarvisClarificationDiscard(answer)).toBe(false);
  });
});
