import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopJarvisVoice } from "./DesktopJarvisVoice.ts";
import { createDesktopJarvisShell } from "../shell/DesktopJarvisShell.ts";

type SentCommand = {
  readonly type: string;
  readonly requestId: string;
  readonly operationId?: string;
};

function makeHarness(
  onCommand: (command: SentCommand, emitLine: (line: string) => void) => void,
) {
  const sent: Array<SentCommand> = [];
  const stdoutHandlers = new Map<string, Array<(chunk: Buffer) => void>>();
  const emitLine = (line: string): void => {
    for (const handler of stdoutHandlers.get("data") ?? []) {
      handler(Buffer.from(`${line}\n`));
    }
  };
  const child = {
    stdin: {
      destroyed: false,
      write: (data: string, callback?: (cause?: Error | null) => void): boolean => {
        for (const line of data.split("\n")) {
          if (line.trim().length === 0) continue;
          const command = JSON.parse(line) as SentCommand;
          sent.push(command);
          onCommand(command, emitLine);
        }
        callback?.(null);
        return true;
      },
    },
    stdout: {
      on: (event: string, handler: (chunk: Buffer) => void): void => {
        const handlers = stdoutHandlers.get(event) ?? [];
        handlers.push(handler);
        stdoutHandlers.set(event, handlers);
      },
    },
    stderr: { on: (): void => undefined },
    once: (): void => undefined,
    kill: (): void => undefined,
    killed: false,
    connected: true,
  };
  const spawn = vi.fn(() => child);
  return { spawn, sent, emitLine };
}

function makeShellHarness(voice: {
  onState: (listener: (state: { status: string; native: boolean }) => void) => () => void;
  onLevel: (listener: (level: number) => void) => () => void;
  getState: () => { status: string; native: boolean };
}) {
  const showInactive = vi.fn();
  const executeJavaScript = vi.fn(() => Promise.resolve());
  const overlay = {
    isDestroyed: () => false,
    showInactive,
    show: vi.fn(),
    hide: vi.fn(),
    setPosition: vi.fn(),
    webContents: {
      executeJavaScript,
      once: (_event: string, callback: () => void) => callback(),
    },
  };
  const shell = createDesktopJarvisShell({
    displayName: "Jarvis",
    iconPath: null,
    platform: "darwin",
    architecture: "arm64",
    globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
    createOverlay: () => overlay as never,
    getOverlayWorkArea: () => ({ x: 0, y: 0, width: 1_600, height: 900 }),
    dispatchVoiceToggle: vi.fn(),
    revealMain: vi.fn(),
    quit: vi.fn(),
    onVoiceState: voice.onState as never,
    onVoiceLevel: voice.onLevel as never,
    getVoiceState: voice.getState as never,
  });
  const overlayTouched = (): boolean =>
    showInactive.mock.calls.length > 0 || executeJavaScript.mock.calls.length > 0;
  const clearOverlay = (): void => {
    showInactive.mockClear();
    executeJavaScript.mockClear();
  };
  return { shell, showInactive, executeJavaScript, overlayTouched, clearOverlay };
}

async function readyVoice(
  fake: ReturnType<typeof makeHarness>,
  voice: { prepare: () => Promise<unknown> },
) {
  const ready = voice.prepare();
  await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalled());
  fake.emitLine(`{"type":"ready"}`);
  await vi.waitFor(() =>
    expect(fake.sent.map((command) => command.type)).toContain("prepare"),
  );
  const prepareId = fake.sent.find((command) => command.type === "prepare")!.requestId;
  fake.emitLine(`{"type":"result","requestId":"${prepareId}","ok":true}`);
  await expect(ready).resolves.toMatchObject({ status: "ready" });
}

describe("desktop remote compute to shell seam", () => {
  it("keeps remote mobile STT/TTS off the laptop toast while local speech still shows", async () => {
    const fake = makeHarness((command, emitLine) => {
      // Reproduce the reported bug: remote compute is represented as local
      // interaction state (transcribing/speaking/ready).
      if (command.type === "remote-transcribe") {
        emitLine(`{"type":"state","state":"transcribing"}`);
        emitLine(
          `{"type":"result","requestId":"${command.requestId}","ok":true,"compute":{"operation":"transcribe","text":"hello from mobile"}}`,
        );
        emitLine(`{"type":"state","state":"ready"}`);
      } else if (command.type === "remote-synthesize") {
        emitLine(`{"type":"state","state":"speaking"}`);
        emitLine(
          `{"type":"result","requestId":"${command.requestId}","ok":true,"compute":{"operation":"synthesize","sampleRate":24000,"channels":1,"pcmBase64":"AAAA"}}`,
        );
        emitLine(`{"type":"state","state":"ready"}`);
      } else if (command.type === "speak") {
        emitLine(`{"type":"state","state":"speaking"}`);
        emitLine(
          `{"type":"result","requestId":"${command.requestId}","ok":true,"outcome":{"status":"played"}}`,
        );
        emitLine(`{"type":"state","state":"ready"}`);
      }
    });
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      executablePath: "/exe",
      spawn: fake.spawn as never,
      emit: () => undefined,
    });
    const { shell, showInactive, overlayTouched, clearOverlay } = makeShellHarness(voice);
    shell.start();
    await readyVoice(fake, voice);
    clearOverlay();

    const transcript = await voice.transcribeRemote({
      format: "pcm-s16le",
      audioBase64: "AAAA",
      sampleRate: 16_000,
      channels: 1,
    });
    expect(transcript).toBe("hello from mobile");
    expect(voice.getState().status).toBe("ready");
    expect(overlayTouched()).toBe(false);

    const synthesized = await voice.synthesizeRemote("hello from mobile");
    expect(synthesized.sampleRate).toBe(24_000);
    expect(voice.getState().status).toBe("ready");
    expect(showInactive).not.toHaveBeenCalled();
    expect(overlayTouched()).toBe(false);

    const spoken = voice.speak("Task finished.", "interaction", "delivery-local-1");
    await vi.waitFor(() =>
      expect(fake.sent.map((command) => command.type)).toContain("speak"),
    );
    await expect(spoken).resolves.toEqual({ status: "played" });
    expect(showInactive).toHaveBeenCalled();

    voice.stop();
    shell.stop();
  });

  it("keeps failed and cancelled remote compute off the laptop toast", async () => {
    const fake = makeHarness((command, emitLine) => {
      if (command.type === "remote-transcribe") {
        emitLine(`{"type":"state","state":"transcribing"}`);
        emitLine(
          `{"type":"result","requestId":"${command.requestId}","ok":false,"message":"model failed"}`,
        );
        emitLine(`{"type":"state","state":"ready"}`);
      } else if (command.type === "remote-synthesize") {
        emitLine(`{"type":"state","state":"speaking"}`);
      } else if (command.type === "remote-cancel") {
        emitLine(`{"type":"result","requestId":"${command.requestId}","ok":true}`);
      } else if (command.type === "speak") {
        emitLine(`{"type":"state","state":"speaking"}`);
        emitLine(
          `{"type":"result","requestId":"${command.requestId}","ok":true,"outcome":{"status":"played"}}`,
        );
        emitLine(`{"type":"state","state":"ready"}`);
      }
    });
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      executablePath: "/exe",
      spawn: fake.spawn as never,
      emit: () => undefined,
    });
    const { shell, showInactive, overlayTouched, clearOverlay } = makeShellHarness(voice);
    shell.start();
    await readyVoice(fake, voice);
    clearOverlay();

    await expect(
      voice.transcribeRemote({
        format: "pcm-s16le",
        audioBase64: "AAAA",
        sampleRate: 16_000,
        channels: 1,
      }),
    ).rejects.toThrow(/model failed/);
    expect(overlayTouched()).toBe(false);

    // Cancel path: a reconnecting mobile client aborts its compute. The abort
    // sends remote-cancel; neither the cancel nor the aborted compute may
    // touch the laptop overlay, and the next local speech still shows.
    const controller = new AbortController();
    const pending = voice.synthesizeRemote("hello", controller.signal, () => undefined);
    await vi.waitFor(() =>
      expect(fake.sent.map((command) => command.type)).toContain("remote-synthesize"),
    );
    controller.abort();
    await vi.waitFor(() =>
      expect(fake.sent.map((command) => command.type)).toContain("remote-cancel"),
    );
    const synthId = fake.sent.find(
      (command) => command.type === "remote-synthesize",
    )!.requestId;
    fake.emitLine(
      `{"type":"result","requestId":"${synthId}","ok":false,"message":"cancelled"}`,
    );
    fake.emitLine(`{"type":"state","state":"ready"}`);
    await expect(pending).rejects.toThrow();
    expect(overlayTouched()).toBe(false);

    const spoken = voice.speak("Back locally.", "interaction", "delivery-local-2");
    await vi.waitFor(() =>
      expect(fake.sent.map((command) => command.type)).toContain("speak"),
    );
    await expect(spoken).resolves.toEqual({ status: "played" });
    expect(showInactive).toHaveBeenCalled();

    voice.stop();
    shell.stop();
  });

  it("keeps remote states, levels, and fatal out of current so local capture works after", async () => {
    type Emitted = { readonly type: string; readonly message?: string };
    const emitted: Array<Emitted> = [];
    const fake = makeHarness((command, emitLine) => {
      if (command.type === "remote-transcribe") {
        emitLine(`{"type":"state","state":"transcribing"}`);
        emitLine(`{"type":"level","level":0.9}`);
        emitLine(
          `{"type":"fatal","message":"remote side died","code":"transcription-failed"}`,
        );
      } else if (command.type === "capture-start") {
        emitLine(`{"type":"state","state":"capturing"}`);
        emitLine(`{"type":"result","requestId":"${command.requestId}","ok":true}`);
      } else if (command.type === "capture-release") {
        emitLine(`{"type":"result","requestId":"${command.requestId}","ok":true}`);
      }
    });
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      executablePath: "/exe",
      spawn: fake.spawn as never,
      emit: (message) => {
        emitted.push(message as Emitted);
      },
      shutdownTimeoutMs: 5,
    });
    const { shell, overlayTouched, clearOverlay } = makeShellHarness(voice);
    shell.start();
    await readyVoice(fake, voice);
    clearOverlay();
    emitted.length = 0;

    const pending = voice.transcribeRemote({
      format: "pcm-s16le",
      audioBase64: "AAAA",
      sampleRate: 16_000,
      channels: 1,
    });
    let remoteFailure: unknown;
    void pending.catch((cause: unknown) => { remoteFailure = cause; });
    await vi.waitFor(() =>
      expect(fake.sent.map((command) => command.type)).toContain("remote-transcribe"),
    );
    // Foreign worker states must neither pollute current nor reach the toast.
    expect(voice.getState().status).toBe("ready");
    expect(overlayTouched()).toBe(false);
    expect(emitted.filter((message) => message.type === "error")).toEqual([]);
    expect(emitted.filter((message) => message.type === "state")).toEqual([]);

    await vi.waitFor(() => expect(remoteFailure).toBeInstanceOf(Error));
    await expect(pending).rejects.toThrow("remote side died");
    expect(voice.getState().status).toBe("ready");
    expect(overlayTouched()).toBe(false);

    // The suppressed fatal still armed a restart, so the next local capture
    // restarts the worker instead of running stale. Drive that restart here.
    const capturePromise = voice.startCapture();
    await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalledTimes(2));
    fake.emitLine(`{"type":"ready"}`);
    await vi.waitFor(() =>
      expect(fake.sent.map((command) => command.type)).toContain("capture-start"),
    );
    await expect(capturePromise).resolves.toEqual({ accepted: true });
    expect(voice.getState().status).toBe("capturing");
    await expect(voice.releaseCapture()).resolves.toEqual({ accepted: true });

    voice.stop();
    shell.stop();
  });

  it("gives a local hotkey clear busy feedback while the remote request stays silent", async () => {
    type Emitted = { readonly type: string; readonly message?: string };
    const emitted: Array<Emitted> = [];
    const fake = makeHarness((command, emitLine) => {
      if (command.type === "remote-transcribe") {
        emitLine(`{"type":"state","state":"transcribing"}`);
      } else if (command.type === "capture-start") {
        emitLine(`{"type":"state","state":"capturing"}`);
        emitLine(`{"type":"result","requestId":"${command.requestId}","ok":true}`);
      } else if (command.type === "capture-release") {
        emitLine(`{"type":"result","requestId":"${command.requestId}","ok":true}`);
      }
    });
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      executablePath: "/exe",
      spawn: fake.spawn as never,
      emit: (message) => {
        emitted.push(message as Emitted);
      },
    });
    const showInactive = vi.fn();
    const executeJavaScript = vi.fn(() => Promise.resolve());
    const overlay = {
      isDestroyed: () => false,
      showInactive,
      show: vi.fn(),
      hide: vi.fn(),
      setPosition: vi.fn(),
      webContents: {
        executeJavaScript,
        once: (_event: string, callback: () => void) => callback(),
      },
    };
    const shell = createDesktopJarvisShell({
      displayName: "Jarvis",
      iconPath: null,
      platform: "linux",
      architecture: "x64",
      globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
      loadPushToTalkHook: async () => null,
      createOverlay: () => overlay as never,
      getOverlayWorkArea: () => ({ x: 0, y: 0, width: 1_600, height: 900 }),
      voice: voice as never,
      onVoiceState: voice.onState as never,
      onVoiceLevel: voice.onLevel as never,
      getVoiceState: voice.getState as never,
      revealMain: vi.fn(),
      quit: vi.fn(),
    });
    shell.start();
    await readyVoice(fake, voice);
    showInactive.mockClear();
    executeJavaScript.mockClear();
    emitted.length = 0;

    const pending = voice.transcribeRemote({
      format: "pcm-s16le",
      audioBase64: "AAAA",
      sampleRate: 16_000,
      channels: 1,
    });
    await vi.waitFor(() =>
      expect(fake.sent.map((command) => command.type)).toContain("remote-transcribe"),
    );
    expect(voice.getState().status).toBe("ready");
    expect(showInactive).not.toHaveBeenCalled();

    // Local origin: the hotkey must explain busy through the typed error
    // seam instead of failing silently or with a generic error only.
    shell.talk();
    await vi.waitFor(() =>
      expect(emitted.filter((message) => message.type === "error")).toHaveLength(1),
    );
    expect(emitted.find((message) => message.type === "error")?.message).toMatch(/busy/i);
    await vi.waitFor(() => expect(showInactive).toHaveBeenCalled());
    expect(executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('"error"'),
      true,
    );

    const remoteId = fake.sent.find((command) => command.type === "remote-transcribe")!
      .requestId;
    fake.emitLine(
      `{"type":"result","requestId":"${remoteId}","ok":true,"compute":{"operation":"transcribe","text":"hello"}}`,
    );
    await expect(pending).resolves.toBe("hello");
    expect(voice.getState().status).toBe("ready");

    // After the remote completes, the next local capture owns the worker.
    showInactive.mockClear();
    executeJavaScript.mockClear();
    await expect(voice.startCapture()).resolves.toEqual({ accepted: true });
    expect(voice.getState().status).toBe("capturing");
    await expect(voice.releaseCapture()).resolves.toEqual({ accepted: true });

    voice.stop();
    shell.stop();
  });
});
