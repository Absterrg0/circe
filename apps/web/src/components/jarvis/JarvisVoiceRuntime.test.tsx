import type { JarvisMeshCatalog } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import type { JarvisCommandTarget } from "../../jarvisBus";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import type { DependencyList, EffectCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const state = vi.hoisted(() => ({
  catalog: null as JarvisMeshCatalog | null,
  effects: [] as Array<() => void>,
  cleanups: [] as Array<() => void>,
  refresh: vi.fn(),
  refreshNode: vi.fn(),
  execute: vi.fn(),
  desk: vi.fn(),
  drain: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness: harness } = await import("../../test/reactHookHarness");
  const sameDependencies = (left: DependencyList, right: DependencyList) =>
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  function useMemo<T>(factory: () => T, dependencies: DependencyList): T {
    const slot = harness.useRef<{ dependencies: DependencyList; value: T } | null>(null);
    if (slot.current === null || !sameDependencies(slot.current.dependencies, dependencies)) {
      slot.current = { dependencies, value: factory() };
    }
    return slot.current.value;
  }
  return {
    ...actual,
    useState: harness.useState,
    useRef: harness.useRef,
    useMemo,
    useCallback: <T,>(callback: T, dependencies: DependencyList) =>
      useMemo(() => callback, dependencies),
    useEffect: (effect: EffectCallback, dependencies: DependencyList) => {
      const slot = harness.useRef<{
        dependencies: DependencyList;
        cleanup: ReturnType<EffectCallback>;
      } | null>(null);
      if (slot.current !== null && sameDependencies(slot.current.dependencies, dependencies))
        return;
      state.effects.push(() => {
        slot.current?.cleanup?.();
        slot.current = { dependencies, cleanup: effect() };
        if (slot.current.cleanup) state.cleanups.push(slot.current.cleanup);
      });
    },
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("./JarvisManager.logic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./JarvisManager.logic")>();
  return {
    ...actual,
    createJarvisVoiceSubmissionQueue: (
      ...args: Parameters<typeof actual.createJarvisVoiceSubmissionQueue>
    ) => {
      const queue = actual.createJarvisVoiceSubmissionQueue(...args);
      state.drain = queue.drain;
      return queue;
    },
  };
});
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "local" }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.catalog }));
vi.mock("../../state/jarvisMesh", () => ({
  jarvisMeshCatalogAtom: "catalog",
  jarvisMeshEnvironment: {
    refresh: "refresh",
    refreshNode: "refreshNode",
    execute: "execute",
    getTaskDesk: "desk",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "refresh" | "refreshNode" | "execute" | "desk") => state[command],
}));
vi.mock("../../jarvisIdentity", () => ({ jarvisReporterIdentity: () => "interaction" }));
import { JarvisVoiceRuntime } from "./JarvisVoiceRuntime";
import {
  onJarvisCommandFeedback,
  requestJarvisCommandAction,
  resetJarvisCommandBusForTests,
} from "../../jarvisBus";

const nodeId = EnvironmentId.make("local");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("task");
const catalog: JarvisMeshCatalog = {
  nodes: [{ nodeId, label: "Local", reachability: "online" }],
  projects: [],
  providers: [],
};

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {
    throw new Error("Deferred not initialized");
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("Jarvis voice runtime", () => {
  let transcript: (
    text: string,
    event?: { captureId: string; purpose: "command" | "diagnostic" },
  ) => void;
  let events: string[];
  let routeNodeId: EnvironmentId;
  let finished: ReturnType<typeof deferred<void>>;
  const unsubscribe = vi.fn();
  const consume = vi.fn();
  const started = vi.fn();
  const speak = vi.fn();

  function render(route?: JarvisCommandTarget | null) {
    hooks.beginRender();
    expect(
      JarvisVoiceRuntime({
        routeTarget:
          route === undefined
            ? { environmentId: routeNodeId, projectId, contextThreadId: threadId }
            : route,
        onTargetConsumed: consume,
        onThreadStarted: started,
      }),
    ).toBeNull();
    for (const effect of state.effects.splice(0)) effect();
  }

  async function ready(route?: JarvisCommandTarget | null) {
    render(route);
    await state.refresh.mock.results[0]?.value;
    render(route);
    await Promise.resolve();
    render(route);
  }

  beforeEach(() => {
    hooks.reset();
    state.effects = [];
    state.cleanups = [];
    events = [];
    routeNodeId = nodeId;
    finished = deferred<void>();
    consume.mockReset();
    unsubscribe.mockReset();
    started.mockReset().mockImplementation(() => finished.resolve());
    speak.mockReset().mockImplementation(async (text: string) => {
      events.push(`speech:${text}`);
      return { status: "spoken" };
    });
    state.catalog = catalog;
    state.refresh.mockReset().mockResolvedValue({ _tag: "Success", value: catalog });
    state.refreshNode.mockReset().mockResolvedValue({ _tag: "Success", value: catalog });
    state.desk
      .mockReset()
      .mockResolvedValue({ _tag: "Success", value: { focusedTask: null, recentTasks: [] } });
    state.execute.mockReset().mockImplementation(async () => {
      events.push("execute");
      return {
        _tag: "Success",
        value: {
          status: "started",
          threadId,
          objective: "Fix the bug",
          acknowledgement: "Working on the bug.",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
        },
      };
    });
    vi.stubGlobal("window", {
      desktopBridge: {
        jarvisVoice: {
          onTranscript: (listener: typeof transcript) => {
            transcript = listener;
            return unsubscribe;
          },
          setRecognitionContext: vi.fn(),
          playAcknowledgement: async () => {
            events.push("cue");
          },
          prepareSpeech: async () => {
            events.push("prepare");
          },
          speak,
        },
      },
    });
  });

  afterEach(() => {
    for (const cleanup of state.cleanups) cleanup();
    vi.unstubAllGlobals();
  });

  it.each(["local", "remote"])(
    "routes a queued capture to its explicit %s node, cues and speaks the result once",
    async (route) => {
      routeNodeId = EnvironmentId.make(route);
      const refresh = deferred<{ _tag: "Success"; value: typeof catalog }>();
      state.catalog = null;
      state.refresh.mockReturnValueOnce(refresh.promise);
      render();
      const feedback = vi.fn();
      onJarvisCommandFeedback(feedback);
      transcript("Fix the bug", { captureId: "capture", purpose: "command" });
      expect(feedback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Waiting for your node to connect. Your instruction is queued.",
        }),
      );
      expect(state.execute).not.toHaveBeenCalled();
      state.catalog = catalog;
      refresh.resolve({ _tag: "Success", value: catalog });
      await refresh.promise;
      render();
      await Promise.resolve();
      render();
      await finished.promise;
      expect(events).toEqual(["prepare", "cue", "execute", "speech:Working on the bug."]);
      expect(state.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          projectRef: { nodeId: routeNodeId, projectId },
          contextThreadId: threadId,
          utterance: "Fix the bug",
          requestMetadata: expect.objectContaining({
            inputMode: "voice",
            sourceUtterance: "Fix the bug",
          }),
        }),
      );
      expect(started).toHaveBeenCalledWith(routeNodeId, threadId);
      expect(state.refreshNode).toHaveBeenCalledWith({ nodeId: routeNodeId });
      expect(state.refresh).toHaveBeenCalledTimes(1);
      transcript("Fix the bug", { captureId: "capture", purpose: "command" });
      expect(state.execute).toHaveBeenCalledTimes(1);
    },
  );

  it("uses a healthy catalog update before a slow peer finishes refreshing", async () => {
    const refresh = deferred<{ _tag: "Success"; value: typeof catalog }>();
    state.catalog = null;
    state.refresh.mockReturnValueOnce(refresh.promise);
    render();
    transcript("Fix the bug", { captureId: "incremental", purpose: "command" });
    expect(state.execute).not.toHaveBeenCalled();
    state.catalog = {
      ...catalog,
      nodes: [
        ...catalog.nodes,
        {
          nodeId: EnvironmentId.make("slow"),
          label: "Slow",
          reachability: "online",
          catalogPending: true,
        },
      ],
    };
    render();
    await finished.promise;
    expect(state.execute).toHaveBeenCalledTimes(1);
    refresh.resolve({ _tag: "Success", value: catalog });
    await refresh.promise;
  });

  it("prepares speech while the selected node is being revalidated", async () => {
    await ready();
    const refresh = deferred<{ _tag: "Success"; value: typeof catalog }>();
    state.refreshNode.mockReturnValueOnce(refresh.promise);
    transcript("Fix the bug", { captureId: "prepare-during-routing", purpose: "command" });
    expect(state.refreshNode).toHaveBeenCalled();
    const beforeRefresh = [...events];
    expect(state.execute).not.toHaveBeenCalled();
    refresh.resolve({ _tag: "Success", value: catalog });
    await finished.promise;
    expect(beforeRefresh).toEqual(["prepare"]);
    expect(events.filter((event) => event === "prepare")).toHaveLength(1);
  });

  it("does not route diagnostic or empty transcripts and releases its subscription", async () => {
    await ready();
    transcript("Fix the bug", { captureId: "diagnostic", purpose: "diagnostic" });
    transcript("um", { captureId: "noise", purpose: "command" });
    expect(state.execute).not.toHaveBeenCalled();
    expect(speak).toHaveBeenCalledWith("I couldn't hear you. Try that again.", "interaction");
    for (const cleanup of state.cleanups.splice(0)) cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("resumes a clarification through the same request and does not replay the original transcript", async () => {
    const question = deferred<void>();
    speak.mockImplementation(async (text: string) => {
      if (text.startsWith("Confirm this project?")) question.resolve();
      return { status: "spoken" };
    });
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "control-target-required",
        prompt: "Confirm this project?",
        choices: ["yes", "no"],
      },
    });
    await ready();
    transcript("Fix the bug", { captureId: "capture", purpose: "command" });
    await question.promise;
    await state.drain?.();
    transcript("yes", { captureId: "reply", purpose: "command" });
    await finished.promise;
    const first = state.execute.mock.calls[0]?.[0];
    const second = state.execute.mock.calls[1]?.[0];
    expect(second).toMatchObject({
      utterance: "yes",
      requestMetadata: {
        requestId: first.requestMetadata.requestId,
        sourceUtterance: "Fix the bug",
      },
    });
    expect(consume).toHaveBeenCalledTimes(1);
  });
  it("preserves the original instruction and sends a typed provider/model answer", async () => {
    const modelCatalog: JarvisMeshCatalog = {
      ...catalog,
      providers: [
        {
          nodeId,
          nodeLabel: "Local",
          available: true,
          snapshot: {
            instanceId: ProviderInstanceId.make("plain"),
            driver: ProviderDriverKind.make("codex"),
            displayName: "Plain",
            enabled: true,
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-09-05T00:00:00.000Z",
            models: [
              { slug: "plain-model", name: "Plain Model", isCustom: false, capabilities: null },
            ],
            slashCommands: [],
            skills: [],
          },
        },
      ],
    };
    state.catalog = modelCatalog;
    state.refresh.mockResolvedValue({ _tag: "Success", value: modelCatalog });
    state.refreshNode.mockResolvedValue({ _tag: "Success", value: modelCatalog });
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "provider-not-found",
        prompt: "Which provider?",
        choices: ["Plain"],
      },
    });
    await ready();
    transcript("Use missing to fix the bug", { captureId: "capture", purpose: "command" });
    await state.drain?.();
    transcript("Plain", { captureId: "answer", purpose: "command" });
    await finished.promise;
    expect(state.execute.mock.calls[1]?.[0]).toMatchObject({
      utterance: "Use missing to fix the bug",
      modelSelection: { instanceId: "plain", model: "plain-model" },
    });
  });

  it("keeps an unmatched project answer pending with the escape spelled out", async () => {
    const jarvisProjectId = ProjectId.make("jarvis");
    const alertifyProjectId = ProjectId.make("alertify");
    const projectsCatalog: JarvisMeshCatalog = {
      nodes: [{ nodeId, label: "Local", reachability: "online" }],
      projects: [
        {
          projectId: jarvisProjectId,
          ref: { nodeId, projectId: jarvisProjectId },
          nodeLabel: "Local",
          title: "Jarvis",
          workspaceRoot: "/jarvis",
          repositoryNames: [],
          aliases: [],
          aliasDetails: [],
        },
        {
          projectId: alertifyProjectId,
          ref: { nodeId, projectId: alertifyProjectId },
          nodeLabel: "Local",
          title: "Alertify",
          workspaceRoot: "/alertify",
          repositoryNames: [],
          aliases: [],
          aliasDetails: [],
        },
      ],
      providers: [],
    };
    state.catalog = projectsCatalog;
    state.refresh.mockResolvedValue({ _tag: "Success", value: projectsCatalog });
    state.refreshNode.mockResolvedValue({ _tag: "Success", value: projectsCatalog });
    const spoken: string[] = [];
    speak.mockImplementation(async (text: string) => {
      spoken.push(text);
      events.push(`speech:${text}`);
      return { status: "spoken" };
    });
    await ready(null);
    transcript("Review the latest changes.", { captureId: "capture", purpose: "command" });
    await state.drain?.();
    await Promise.resolve();
    expect(spoken.at(-1)).toMatch(/Which project/);
    // Arbitrary speech is not fresh work: it stays on the pending question.
    transcript("take a look at the failing tests", { captureId: "answer", purpose: "command" });
    await state.drain?.();
    await Promise.resolve();
    expect(state.execute).not.toHaveBeenCalled();
    expect(spoken.at(-1)).toMatch(/couldn't match that project/);
    expect(spoken.at(-1)).toMatch(/cancel/);
    expect(spoken.at(-1)).toMatch(/start over/);
    // A spoken ordinal still answers through the shared parser.
    transcript("one", { captureId: "choice", purpose: "command" });
    await finished.promise;
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
      projectRef: { nodeId, projectId: jarvisProjectId },
    });
  });

  it("verifies cancel before starting over on a server question", async () => {
    const question = deferred<void>();
    const restarted = deferred<void>();
    speak.mockImplementation(async (text: string) => {
      events.push(`speech:${text}`);
      if (text.startsWith("Confirm this project?")) question.resolve();
      if (/starting over/i.test(text)) restarted.resolve();
      return { status: "spoken" };
    });
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "control-target-required",
        prompt: "Confirm this project?",
        choices: ["yes", "no"],
        clarificationFrameId: "frame-1",
      },
    });
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "acknowledged",
        action: "interrupted",
        threadId,
        projectId,
        message: "Interrupted.",
      },
    });
    await ready();
    transcript("Fix the bug", { captureId: "capture", purpose: "command" });
    await question.promise;
    await state.drain?.();
    transcript("start over", { captureId: "restart", purpose: "command" });
    await restarted.promise;
    const first = state.execute.mock.calls[0]?.[0];
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(state.execute.mock.calls[1]?.[0]).toMatchObject({
      utterance: "cancel",
      clarificationFrameId: "frame-1",
      requestMetadata: {
        requestId: first.requestMetadata.requestId,
        sourceUtterance: "Fix the bug",
      },
    });
    expect(events).toContain(
      "speech:Okay, starting over. Say your instruction with its project name.",
    );
  });

  it.each(["new instruction:", "actually,", "instead,", "never mind,"])(
    "routes a %s replacement as fresh work after verified cancel",
    async (prefix) => {
      const question = deferred<void>();
      speak.mockImplementation(async (text: string) => {
        events.push(`speech:${text}`);
        if (text.startsWith("Confirm this project?")) question.resolve();
        return { status: "spoken" };
      });
      state.execute.mockResolvedValueOnce({
        _tag: "Success",
        value: {
          status: "needs-input",
          reason: "control-target-required",
          prompt: "Confirm this project?",
          choices: ["yes", "no"],
          clarificationFrameId: "frame-1",
        },
      });
      state.execute.mockResolvedValueOnce({
        _tag: "Success",
        value: {
          status: "acknowledged",
          action: "interrupted",
          threadId,
          projectId,
          message: "Interrupted.",
        },
      });
      await ready();
      transcript("Fix the bug", { captureId: "capture", purpose: "command" });
      await question.promise;
      await state.drain?.();
      transcript(`${prefix} Implement a feature`, {
        captureId: "replace",
        purpose: "command",
      });
      await finished.promise;
      expect(state.execute).toHaveBeenCalledTimes(3);
      const retired = state.execute.mock.calls[0]?.[0];
      const replacement = state.execute.mock.calls[2]?.[0];
      expect(replacement.utterance).toBe("Implement a feature");
      expect(replacement.requestMetadata.requestId).not.toBe(retired.requestMetadata.requestId);
      expect(replacement.clarificationFrameId).toBeUndefined();
    },
  );

  it("retains a server question when verified cancel fails", async () => {
    const question = deferred<void>();
    const waiting = deferred<void>();
    speak.mockImplementation(async (text: string) => {
      events.push(`speech:${text}`);
      if (text.startsWith("Confirm this project?")) question.resolve();
      if (/still waiting/i.test(text)) waiting.resolve();
      return { status: "spoken" };
    });
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "control-target-required",
        prompt: "Confirm this project?",
        choices: ["yes", "no"],
        clarificationFrameId: "frame-1",
      },
    });
    state.execute.mockRejectedValueOnce(new Error("offline"));
    await ready();
    transcript("Fix the bug", { captureId: "capture", purpose: "command" });
    await question.promise;
    await state.drain?.();
    transcript("start over", { captureId: "restart", purpose: "command" });
    await waiting.promise;
    expect(state.execute).toHaveBeenCalledTimes(2);
    // The retired question is still parked, so the next answer still binds
    // its exact frame and request instead of starting fresh work.
    transcript("yes", { captureId: "answer", purpose: "command" });
    await finished.promise;
    const first = state.execute.mock.calls[0]?.[0];
    expect(state.execute.mock.calls[2]?.[0]).toMatchObject({
      utterance: "yes",
      clarificationFrameId: "frame-1",
      requestMetadata: {
        requestId: first.requestMetadata.requestId,
        sourceUtterance: "Fix the bug",
      },
    });
  });

  it("gives busy feedback instead of silently dropping cancel while a clarification cancel is in-flight", async () => {
    resetJarvisCommandBusForTests();
    const question = deferred<void>();
    speak.mockImplementation(async (text: string) => {
      events.push("speech:" + text);
      if (text.startsWith("Confirm this project?")) question.resolve();
      return { status: "spoken" };
    });
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "control-target-required",
        prompt: "Confirm this project?",
        choices: ["yes", "no"],
        clarificationFrameId: "frame-1",
      },
    });
    await ready();
    transcript("Fix the bug", { captureId: "capture", purpose: "command" });
    await question.promise;
    await state.drain?.();
    const feedback: string[] = [];
    const off = onJarvisCommandFeedback((entry) => feedback.push(entry.text));
    try {
      let release!: (value: unknown) => void;
      const gate = new Promise<unknown>((resolve) => {
        release = resolve;
      });
      state.execute.mockReturnValueOnce(gate);
      requestJarvisCommandAction({ type: "cancel", inputMode: "text" });
      while (state.execute.mock.calls.length < 2) await Promise.resolve();
      requestJarvisCommandAction({ type: "cancel", inputMode: "text" });
      await Promise.resolve();
      await Promise.resolve();
      expect(state.execute).toHaveBeenCalledTimes(2);
      expect(feedback.join(" | ")).toMatch(/still submitting|try .* moment/i);
      release({
        _tag: "Success",
        value: {
          status: "acknowledged",
          action: "interrupted",
          threadId,
          projectId,
          message: "Interrupted.",
        },
      });
      await gate;
      await Promise.resolve();
    } finally {
      off();
    }
  });

  it("drains queued work after a server cancel releases the busy gate", async () => {
    resetJarvisCommandBusForTests();
    const question = deferred<void>();
    speak.mockImplementation(async (text: string) => {
      events.push("speech:" + text);
      if (text.startsWith("Confirm this project?")) question.resolve();
      return { status: "spoken" };
    });
    let releaseFirst!: (value: unknown) => void;
    const firstGate = new Promise<unknown>((resolve) => {
      releaseFirst = resolve;
    });
    state.execute.mockReturnValueOnce(firstGate);
    await ready();
    transcript("Fix the bug", { captureId: "capture-a", purpose: "command" });
    while (state.execute.mock.calls.length < 1) await Promise.resolve();
    transcript("Second instruction", { captureId: "capture-b", purpose: "command" });
    await Promise.resolve();
    releaseFirst({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "control-target-required",
        prompt: "Confirm this project?",
        choices: ["yes", "no"],
        clarificationFrameId: "frame-1",
      },
    });
    await question.promise;
    await state.drain?.();
    const first = state.execute.mock.calls[0]?.[0];
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "acknowledged",
        action: "interrupted",
        threadId,
        projectId,
        message: "Interrupted.",
      },
    });
    requestJarvisCommandAction({ type: "cancel", inputMode: "text" });
    await finished.promise;
    expect(state.execute).toHaveBeenCalledTimes(3);
    expect(state.execute.mock.calls[1]?.[0]).toMatchObject({
      utterance: "cancel",
      clarificationFrameId: "frame-1",
      requestMetadata: {
        requestId: first.requestMetadata.requestId,
        sourceUtterance: "Fix the bug",
      },
    });
    expect(state.execute.mock.calls[2]?.[0]).toMatchObject({ utterance: "Second instruction" });
  });
});
