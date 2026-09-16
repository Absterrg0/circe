import { describe, expect, it } from "vite-plus/test";

import type { DecisionAnswer } from "../decision.ts";
import {
  buildDesktopDecisionRequest,
  composeDesktopSelection,
  extractQuotedText,
} from "./desktopDecision.ts";

const windows = [
  { key: "Mail", title: "Mail", app: "Mail" },
  { key: "Sprint board", title: "Sprint board", app: "Browser" },
];

const choice = (value: string, confidence = 0.9): DecisionAnswer => ({
  type: "choice",
  choice: value,
  probabilities: { [value]: confidence },
  confidence,
});

const noul = (value: number): DecisionAnswer => ({ type: "noul", noul: value });

const base = {
  window: choice("Mail"),
  action: choice("focus"),
  typed_text_is_quoted: noul(0.05),
  key_name: choice("none"),
  direction: choice("none"),
  needs_clarification: noul(0.05),
};

describe("desktop decision experiment", () => {
  it("enumerates open windows and a closed action set", () => {
    const request = buildDesktopDecisionRequest({ utterance: "focus mail", windows });
    const windowQuestion = request.questions.window!;
    expect(windowQuestion.type).toBe("choice");
    if (windowQuestion.type !== "choice") return;
    expect(Object.keys(windowQuestion.criteria)).toEqual(
      expect.arrayContaining(["Mail", "Sprint board", "active", "none"]),
    );
    expect(request.questions.action?.type).toBe("choice");
  });

  it("selects a window and action", () => {
    const result = composeDesktopSelection({ utterance: "focus mail", answers: base });
    expect(result).toEqual({ status: "selected", window: "Mail", action: "focus" });
  });

  it("requires a quoted span to type and takes the text from code, not the model", () => {
    const utterance = 'type "hello there" into mail';
    expect(extractQuotedText(utterance)).toBe("hello there");
    const withoutQuote = composeDesktopSelection({
      utterance: "type hello into mail",
      answers: { ...base, action: choice("type"), typed_text_is_quoted: noul(0.95) },
    });
    expect(withoutQuote.status).toBe("clarify");
    const withQuote = composeDesktopSelection({
      utterance,
      answers: { ...base, action: choice("type"), typed_text_is_quoted: noul(0.95) },
    });
    expect(withQuote).toEqual({
      status: "selected",
      window: "Mail",
      action: "type",
      text: "hello there",
    });
  });

  it("clarifies below the action floor", () => {
    const result = composeDesktopSelection({
      utterance: "do something",
      answers: { ...base, action: choice("click", 0.4) },
    });
    expect(result.status).toBe("clarify");
  });
});
