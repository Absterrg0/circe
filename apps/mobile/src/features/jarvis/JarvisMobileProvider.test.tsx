import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import type { JarvisMeshCatalog } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import { reactHookHarness as hooks } from "../../../../web/src/test/reactHookHarness";

const state = vi.hoisted(() => ({
  catalog: null as JarvisMeshCatalog | null,
  execute: vi.fn(),
  desk: vi.fn(),
  refresh: vi.fn(),
  focus: vi.fn(),
  lookup: vi.fn(),
  converse: vi.fn(),
  save: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../../../web/src/test/reactHookHarness");
  return {
    ...actual,
    ...reactHookHarness,
    // These tests explicitly start/select tasks through the context actions.
    // Foreground and connection subscriptions are outside this dispatch seam.
    useEffect: () => undefined,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../../../web/src/test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../lib/uuid", () => ({ uuidv4: () => crypto.randomUUID() }));
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-haptics", () => ({
  impactAsync: async () => {},
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "catalog" ? state.catalog : { _tag: "Success", value: {} },
  useAtomSet: () => state.save,
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: "preferences",
  updateMobilePreferencesAtom: "save",
}));
vi.mock("../../state/jarvis", () => ({ jarvisEnvironment: {} }));
vi.mock("../../state/threads", () => ({ lookupThread: "lookup" }));
vi.mock("../../state/jarvisMesh", () => ({
  jarvisMeshCatalogAtom: "catalog",
  jarvisMeshEnvironment: {
    refresh: "refresh",
    execute: "execute",
    converse: "converse",
    getTaskDesk: "desk",
    focusTask: "focus",
  },
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (key: "refresh" | "execute" | "converse" | "desk" | "focus" | "lookup") =>
    state[key],
}));
import { JarvisMobileProvider, type useJarvisController } from "./JarvisMobileProvider";

const nodeId = EnvironmentId.make("node-A");
const projectId = ProjectId.make("project-A");
const threadId = ThreadId.make("thread-A");
const projectRef = { nodeId, projectId };
const project = {
  ref: projectRef,
  projectId,
  title: "Work",
  workspaceRoot: "/work",
  nodeLabel: "Node A",
  repositoryNames: [],
  aliases: [],
  aliasDetails: [],
};
const desk = (requestId: string, kind: "approval" | "user-input" = "approval") => ({
  _tag: "Success",
  value: {
    focusedTask: {
      threadId,
      projectRef,
      taskRef: { executionNodeId: nodeId, threadId },
      pendingReply: { kind, requestId },
    },
    recentTasks: [],
    pendingInteraction: null,
  },
});
function render() {
  hooks.beginRender();
  const tree = JarvisMobileProvider({ children: null });
  if (!isValidElement<{ value: ReturnType<typeof useJarvisController> }>(tree))
    throw new Error("Missing provider value");
  return tree.props.value;
}
async function instruction(text: string) {
  const controller = render();
  await controller.runInstruction(controller.createTextTurn(), text);
}
async function startTask() {
  state.execute.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      status: "started",
      threadId,
      taskRef: { executionNodeId: nodeId, threadId },
      objective: "Work",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
    },
  });
  await instruction("Implement a feature");
}
beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  state.execute.mockReset();
  state.catalog = {
    nodes: [{ nodeId, label: "Node A", reachability: "online" }],
    projects: [project],
    providers: [],
  };
  state.desk.mockResolvedValue({
    _tag: "Success",
    value: { focusedTask: null, recentTasks: [], pendingInteraction: null },
  });
  state.execute.mockResolvedValue({
    _tag: "Success",
    value: { status: "acknowledged", action: "stopped", message: "Done" },
  });
});
describe("mobile provider answer transport lifecycle", () => {
  it.each(["approval", "user-input"] as const)(
    "retains the %s identity after a direct answer transport failure",
    async (kind) => {
      await startTask();
      state.desk.mockResolvedValue(desk("request-A", kind));
      state.execute.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("offline") });
      await instruction("allow");
      const original = state.execute.mock.calls[1]?.[0];
      expect(original).toMatchObject({
        contextThreadId: threadId,
        expectedReply: { kind: kind === "approval" ? "approval" : "input", requestId: "request-A" },
      });
      state.desk.mockResolvedValue(desk("request-B", kind));
      await instruction("allow");
      expect(state.execute.mock.calls[2]?.[0]).toEqual(original);
    },
  );
  it("discards a failed direct answer locally before accepting another instruction", async () => {
    await startTask();
    state.desk.mockResolvedValue(desk("request-A"));
    state.execute.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("offline") });
    await instruction("allow");
    state.desk.mockResolvedValue(desk("request-B"));
    await instruction("cancel");
    expect(state.execute).toHaveBeenCalledTimes(2);
    await instruction("allow");
    expect(state.execute.mock.calls[2]?.[0].expectedReply).toEqual({
      kind: "approval",
      requestId: "request-B",
    });
  });
  it("releases a failed direct answer when the user explicitly changes project", async () => {
    await startTask();
    state.desk.mockResolvedValue(desk("request-A"));
    state.execute.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("offline") });
    await instruction("allow");
    render().selectProject(project);
    await instruction("Start a different task");
    expect(state.execute).toHaveBeenCalledTimes(3);
    expect(state.execute.mock.calls[2]?.[0].expectedReply).toBeUndefined();
    expect(state.execute.mock.calls[2]?.[0].contextThreadId).toBeUndefined();
  });

  it("hands a received model clarification to the model-answer owner", async () => {
    await startTask();
    state.desk.mockResolvedValue(desk("request-A"));
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "effort-missing",
        prompt: "Which effort?",
        choices: ["low"],
        modelDraft: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
      },
    });
    await instruction("allow");
    await instruction("cancel");
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(render().message).toBe("Okay, I discarded that request.");
    // The next instruction must not remain intercepted by the model question.
    await instruction("Start another task");
    expect(state.execute).toHaveBeenCalledTimes(3);
  });

  it("keeps a model question pending on an unmatched answer instead of dispatching fresh work", async () => {
    await startTask();
    state.desk.mockResolvedValue(desk("request-A"));
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "effort-missing",
        prompt: "Which effort?",
        choices: ["low"],
        modelDraft: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
      },
    });
    await instruction("allow");
    expect(state.execute).toHaveBeenCalledTimes(2);
    // "use the fancy model please" names no catalog effort: it must re-prompt
    // with the escape instead of falling through into fresh work.
    await instruction("use the fancy model please");
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(render().message).toMatch(/cancel/i);
    // The question is still pending, so cancel still discards it instead of
    // dispatching "cancel" as fresh work.
    await instruction("cancel");
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(render().message).toBe("Okay, I discarded that request.");
  });

  it.each(["start over", "actually,", "instead,", "never mind,"])(
    "replaces a local project question using %s",
    async (prefix) => {
      const homeProjectId = ProjectId.make("project-B");
      const home = {
        ref: { nodeId, projectId: homeProjectId },
        projectId: homeProjectId,
        title: "Home",
        workspaceRoot: "/home",
        nodeLabel: "Node A",
        repositoryNames: [],
        aliases: [],
        aliasDetails: [],
      };
      state.catalog = {
        nodes: [{ nodeId, label: "Node A", reachability: "online" }],
        projects: [project, home],
        providers: [],
      };
      await instruction("Review the latest changes.");
      expect(state.execute).not.toHaveBeenCalled();
      expect(render().message).toMatch(/Which project/);
      if (prefix === "start over") {
        await instruction(prefix);
        expect(state.execute).not.toHaveBeenCalled();
        expect(render().message).toMatch(/starting over/i);
        await instruction("In Home, review the latest changes.");
      } else {
        await instruction(`${prefix} In Home, review the latest changes.`);
      }
      expect(state.execute).toHaveBeenCalledTimes(1);
      expect(state.execute.mock.calls[0]?.[0]).toMatchObject({
        utterance: "In Home, review the latest changes.",
        projectRef: home.ref,
      });
    },
  );

  it("verifies cancel before replacing a server question on restart", async () => {
    await startTask();
    state.desk.mockResolvedValue(desk("request-A"));
    state.execute.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        status: "needs-input",
        reason: "task-choice",
        prompt: "Which task should I use?",
      },
    });
    await instruction("allow");
    expect(state.execute).toHaveBeenCalledTimes(2);
    // No frame id travels with the question, so the verified cancel is a safe
    // no-op: nothing new goes out and the invite replaces the prompt.
    await instruction("start over");
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(render().message).toMatch(/starting over/i);
    // A replacement routes fresh under a new request identity, never as an
    // answer to the retired question.
    await instruction("new instruction: Implement a feature");
    expect(state.execute).toHaveBeenCalledTimes(3);
    const retiredRequestId = state.execute.mock.calls[1]?.[0].requestMetadata.requestId;
    const replacement = state.execute.mock.calls[2]?.[0];
    expect(replacement.utterance).toBe("Implement a feature");
    expect(replacement.requestMetadata.requestId).not.toBe(retiredRequestId);
    expect(replacement.clarificationFrameId).toBeUndefined();
  });

  it.each(["success", "failure"] as const)(
    "holds mobile instructions during %s of a server question cancellation",
    async (outcome) => {
      state.execute.mockResolvedValueOnce({
        _tag: "Success",
        value: {
          status: "needs-input",
          reason: "task-choice",
          prompt: "Which task?",
          clarificationFrameId: "frame-mobile-1",
        },
      });
      await instruction("Review Work");
      let finishCancel!: (value: unknown) => void;
      state.execute.mockReturnValueOnce(
        new Promise((resolve) => {
          finishCancel = resolve;
        }),
      );
      const restart = instruction("start over");
      expect(state.execute).toHaveBeenCalledTimes(2);
      expect(state.execute.mock.calls[1]?.[0]).toMatchObject({
        utterance: "cancel",
        clarificationFrameId: "frame-mobile-1",
      });
      const fresh = instruction("Implement another feature in Work");
      await Promise.resolve();
      await Promise.resolve();
      expect(state.execute).toHaveBeenCalledTimes(2);
      finishCancel(
        outcome === "success"
          ? {
              _tag: "Success",
              value: { status: "acknowledged", action: "stopped", message: "Cancelled" },
            }
          : { _tag: "Failure", cause: new Error("Node disconnected") },
      );
      await Promise.all([restart, fresh]);
      if (outcome === "failure") {
        expect(render().message).toMatch(/still waiting on its node/);
        await instruction("one");
        expect(state.execute.mock.calls.at(-1)?.[0]).toMatchObject({
          utterance: "one",
          clarificationFrameId: "frame-mobile-1",
        });
        return;
      }
      await instruction("Implement another feature in Work");
      expect(state.execute.mock.calls.at(-1)?.[0]).toMatchObject({
        utterance: "Implement another feature in Work",
      });
      expect(state.execute.mock.calls.at(-1)?.[0].clarificationFrameId).toBeUndefined();
    },
  );

  it("gives busy feedback instead of silently dropping an explicit restart while submitting", async () => {
    let release!: (value: { _tag: string; value: unknown }) => void;
    const gate = new Promise<{ _tag: string; value: unknown }>((resolve) => {
      release = resolve;
    });
    state.execute.mockReturnValueOnce(gate);
    const controller = render();
    const first = controller.runInstruction(controller.createTextTurn(), "Implement a feature");
    while (state.execute.mock.calls.length === 0) await Promise.resolve();
    await instruction("start over");
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(render().message ?? String(render().message)).toMatch(/still submitting|try .* moment/i);
    release({
      _tag: "Success",
      value: { status: "acknowledged", action: "stopped", message: "Done" },
    });
    await first;
    await instruction("start over");
    expect(render().message).toMatch(/starting over/i);
  });
});
