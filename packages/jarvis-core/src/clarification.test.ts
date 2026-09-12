import { describe, expect, it } from "vite-plus/test";

import {
  extractJarvisClarificationRestart,
  formatJarvisClarificationPrompt,
  isJarvisClarificationDiscard,
} from "./clarification.ts";
import {
  resolveJarvisClarificationChoice,
  resolveJarvisClarificationOrdinal,
  type JarvisClarificationCandidate,
} from "./clarification.ts";

describe("shared clarification discard", () => {
  it.each([
    "cancel",
    "Cancel.",
    "none",
    "never mind",
    "nevermind",
    "forget it",
    "stop",
    "no thanks",
  ])("exits any pending clarification: %s", (answer) => {
    expect(isJarvisClarificationDiscard(answer)).toBe(true);
  });

  it.each(["no, use the second project", "stop the running task", "2", "rivvl", "yes"])(
    "keeps project answers and affirmations: %s",
    (answer) => {
      expect(isJarvisClarificationDiscard(answer)).toBe(false);
    },
  );
});

const catalogCandidate = (
  title: string,
  nodeLabel: string,
  extraNames: ReadonlyArray<string> = [],
): JarvisClarificationCandidate => ({
  label: `${title} — ${nodeLabel}`,
  names: [title, `${title} — ${nodeLabel}`, ...extraNames],
});

describe("shared clarification ordinal", () => {
  it.each([
    ["1", 0],
    ["2", 1],
    ["one", 0],
    ["won", 0],
    ["two", 1],
    ["to", 1],
    ["too", 1],
    ["three", 2],
    ["four", 3],
    ["for", 3],
    ["eight", 7],
    ["ate", 7],
    ["first", 0],
    ["second", 1],
    ["the first", 0],
    ["the second one", 1],
    ["first one", 0],
    ["1st", 0],
    ["the 2nd", 1],
    ["number one", 0],
    ["number won", 0],
    ["number 2", 1],
    ["option one", 0],
    ["option 2", 1],
  ] as const)("maps spoken answer %s to index %d", (answer, index) => {
    expect(resolveJarvisClarificationOrdinal(answer)).toBe(index);
  });

  it.each(["rivvl", "hello", "", "zero", "number", "option", "6th banana"])(
    "leaves non-ordinals unparsed: %s",
    (answer) => {
      expect(resolveJarvisClarificationOrdinal(answer)).toBeUndefined();
    },
  );
});

describe("shared clarification choice", () => {
  it("matches a bare catalog name", () => {
    const candidates = [catalogCandidate("Alpha", "Laptop"), catalogCandidate("Beta", "Laptop")];
    expect(resolveJarvisClarificationChoice(candidates, "Alpha")?.label).toBe("Alpha — Laptop");
    expect(resolveJarvisClarificationChoice(candidates, "beta")?.label).toBe("Beta — Laptop");
  });

  it("matches a node-qualified label", () => {
    const candidates = [catalogCandidate("Alpha", "Laptop"), catalogCandidate("Alpha", "Server")];
    expect(resolveJarvisClarificationChoice(candidates, "Alpha — Server")?.label).toBe(
      "Alpha — Server",
    );
  });

  it("strips a possessive before matching catalog names", () => {
    const candidates = [catalogCandidate("Alpha", "Laptop"), catalogCandidate("Beta", "Laptop")];
    expect(resolveJarvisClarificationChoice(candidates, "Alpha's")?.label).toBe("Alpha — Laptop");
    expect(resolveJarvisClarificationChoice(candidates, "beta's pull request")?.label).toBe(
      undefined,
    );
  });

  it("prefers the spoken ordinal over catalog order", () => {
    const candidates = [catalogCandidate("Alpha", "Laptop"), catalogCandidate("Beta", "Laptop")];
    expect(resolveJarvisClarificationChoice(candidates, "one")?.label).toBe("Alpha — Laptop");
    expect(resolveJarvisClarificationChoice(candidates, "two")?.label).toBe("Beta — Laptop");
    expect(resolveJarvisClarificationChoice(candidates, "number one")?.label).toBe(
      "Alpha — Laptop",
    );
  });

  it("resolves heard ordinals to the same position", () => {
    const candidates = [catalogCandidate("Rivvl", "Laptop"), catalogCandidate("Rivvl", "Desktop")];
    expect(resolveJarvisClarificationChoice(candidates, "won")?.label).toBe("Rivvl — Laptop");
    expect(resolveJarvisClarificationChoice(candidates, "to")?.label).toBe("Rivvl — Desktop");
    expect(resolveJarvisClarificationChoice(candidates, "number won")?.label).toBe(
      "Rivvl — Laptop",
    );
  });

  it("leaves ambiguous bare names pending instead of guessing", () => {
    const candidates = [catalogCandidate("Alpha", "Laptop"), catalogCandidate("Alpha", "Server")];
    expect(resolveJarvisClarificationChoice(candidates, "Alpha")).toBeUndefined();
  });

  it("leaves duplicate Rivvl bare names pending while one still selects", () => {
    const candidates = [catalogCandidate("Rivvl", "Laptop"), catalogCandidate("Rivvl", "Desktop")];
    expect(resolveJarvisClarificationChoice(candidates, "Rivvl")).toBeUndefined();
    expect(resolveJarvisClarificationChoice(candidates, "Rivvl's")).toBeUndefined();
    expect(resolveJarvisClarificationChoice(candidates, "one")?.label).toBe("Rivvl — Laptop");
    expect(resolveJarvisClarificationChoice(candidates, "two")?.label).toBe("Rivvl — Desktop");
    expect(resolveJarvisClarificationChoice(candidates, "Rivvl — Desktop")?.label).toBe(
      "Rivvl — Desktop",
    );
  });

  it("bounds ordinals to the candidate list", () => {
    const candidates = [catalogCandidate("Alpha", "Laptop")];
    expect(resolveJarvisClarificationChoice(candidates, "two")).toBeUndefined();
    expect(resolveJarvisClarificationChoice(candidates, "5")).toBeUndefined();
  });

  it("rejects an out-of-range ordinal instead of falling back to a matching name", () => {
    const candidates = [catalogCandidate("Two", "Laptop"), catalogCandidate("Three", "Laptop")];
    // "three" parses as position 3 (index 2, out of range for two candidates)
    // and also names the second candidate. Bounds win: no guess.
    expect(resolveJarvisClarificationChoice(candidates, "three")).toBeUndefined();
  });

  it("matches multi-word project names", () => {
    const candidates = [
      catalogCandidate("My Project", "Laptop"),
      catalogCandidate("Beta", "Laptop"),
    ];
    expect(resolveJarvisClarificationChoice(candidates, "My Project")?.label).toBe(
      "My Project — Laptop",
    );
  });

  it("leaves fresh instructions unmatched", () => {
    const candidates = [catalogCandidate("Alpha", "Laptop"), catalogCandidate("Beta", "Laptop")];
    expect(resolveJarvisClarificationChoice(candidates, "stop the running task")).toBeUndefined();
    expect(
      resolveJarvisClarificationChoice(candidates, "take a look at alpha's pull request"),
    ).toBeUndefined();
  });
});

describe("shared clarification restart", () => {
  it.each(["start over", "Start over."])("recognizes a bare restart: %s", (answer) => {
    expect(extractJarvisClarificationRestart(answer)).toEqual({ kind: "restart" });
  });

  it("replaces pending with the new instruction text", () => {
    expect(
      extractJarvisClarificationRestart("new instruction: In Alertify, review the latest changes."),
    ).toEqual({
      kind: "replace",
      utterance: "In Alertify, review the latest changes.",
    });
  });

  it.each([
    "actually, Check out Jarvis and fix the login bug.",
    "instead Check out Jarvis and fix the login bug.",
    "never mind, Check out Jarvis and fix the login bug.",
  ])("grounds an explicitly replacement instruction from scratch: %s", (answer) => {
    expect(extractJarvisClarificationRestart(answer)).toEqual({
      kind: "replace",
      utterance: "Check out Jarvis and fix the login bug.",
    });
  });

  it.each(["one", "Rivvl", "cancel", "never mind", "start something new", ""])(
    "leaves ordinary answers alone: %s",
    (answer) => {
      expect(extractJarvisClarificationRestart(answer)).toBeUndefined();
    },
  );
});

describe("clarification prompt", () => {
  it("numbers candidates for a spoken answer", () => {
    expect(
      formatJarvisClarificationPrompt("Which project did you mean?", [
        "Rivvl — Laptop",
        "Rivvl — Desktop",
      ]),
    ).toBe("Which project did you mean? 1. Rivvl — Laptop  2. Rivvl — Desktop");
  });

  it("leaves prompts without choices alone", () => {
    expect(formatJarvisClarificationPrompt("Say your instruction.", [])).toBe(
      "Say your instruction.",
    );
  });
});
