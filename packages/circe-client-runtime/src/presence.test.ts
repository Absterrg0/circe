import { describe, expect, it } from "vite-plus/test";

import {
  T3CODE_PRESENCE_MODES,
  T3CODE_PRESENCE_PALETTE,
  T3CODE_PRESENCE_SHADER_MOTION,
  T3CODE_PRESENCE_FRAGMENT_SHADER,
  T3CODE_PRESENCE_VERTEX_SHADER,
  createCircePresenceLifecycle,
} from "./presence.ts";

describe("Circe presence visual core", () => {
  it("exposes one semantic palette and transparent flowing-ribbon shader", () => {
    expect(T3CODE_PRESENCE_MODES).toEqual([
      "idle",
      "listening",
      "working",
      "speaking",
      "attention",
      "error",
    ]);
    expect(Object.keys(T3CODE_PRESENCE_PALETTE)).toEqual([...T3CODE_PRESENCE_MODES]);
    expect(T3CODE_PRESENCE_FRAGMENT_SHADER).toContain("u_time");
    expect(T3CODE_PRESENCE_FRAGMENT_SHADER).toContain("u_progress");
    expect(T3CODE_PRESENCE_FRAGMENT_SHADER).toContain("u_resolution");
    expect(T3CODE_PRESENCE_FRAGMENT_SHADER).toContain("float fbm");
    expect(T3CODE_PRESENCE_FRAGMENT_SHADER).toContain("float strand");
    expect(T3CODE_PRESENCE_FRAGMENT_SHADER).toContain("upperCenter");
    expect(T3CODE_PRESENCE_FRAGMENT_SHADER).toContain("middleCenter");
    expect(T3CODE_PRESENCE_FRAGMENT_SHADER).toContain("lowerCenter");
    expect(T3CODE_PRESENCE_FRAGMENT_SHADER).toContain("transparent between strands");
    expect(T3CODE_PRESENCE_FRAGMENT_SHADER).toContain("never a radial disc mask");
    expect(T3CODE_PRESENCE_FRAGMENT_SHADER).not.toContain("aperture");
    expect(T3CODE_PRESENCE_FRAGMENT_SHADER).not.toContain("length(p)");
    expect(T3CODE_PRESENCE_VERTEX_SHADER).toContain("a_position");
    expect(T3CODE_PRESENCE_SHADER_MOTION.frameIntervalMs).toBeGreaterThanOrEqual(30);
    expect(T3CODE_PRESENCE_SHADER_MOTION.maxFrames).toBeGreaterThan(0);
  });

  it("runs only a bounded visible active burst and cancels on state changes", () => {
    const queued = new Map<number, (timestamp: number) => void>();
    const cancelled: number[] = [];
    let nextHandle = 0;
    const draws: Array<{ progress: number; timestamp: number }> = [];
    const lifecycle = createCircePresenceLifecycle({
      requestFrame: (callback) => {
        const handle = ++nextHandle;
        queued.set(handle, callback);
        return handle;
      },
      cancelFrame: (handle) => {
        cancelled.push(handle);
        queued.delete(handle);
      },
      draw: (progress, timestamp) => draws.push({ progress, timestamp }),
      visible: true,
      reducedMotion: false,
      now: () => 0,
    });

    lifecycle.setMode("idle");
    expect(queued.size).toBe(0);
    lifecycle.setMode("listening");
    expect(queued.size).toBe(1);
    queued.get(1)!(40);
    queued.delete(1);
    expect(draws).toEqual([{ progress: 0, timestamp: 40 }]);
    expect(queued.size).toBe(1);
    lifecycle.setMode("idle");
    expect(cancelled).toEqual([2]);
    expect(queued.size).toBe(0);
    lifecycle.dispose();
  });

  it("uses a custom clock consistently with RAF timestamps", () => {
    const queued = new Map<number, (timestamp: number) => void>();
    let nextHandle = 0;
    let currentTime = 1_000;
    const draws: Array<{ progress: number; timestamp: number }> = [];
    const lifecycle = createCircePresenceLifecycle({
      requestFrame: (callback) => {
        const handle = ++nextHandle;
        queued.set(handle, callback);
        return handle;
      },
      cancelFrame: (handle) => queued.delete(handle),
      draw: (progress, timestamp) => draws.push({ progress, timestamp }),
      visible: true,
      reducedMotion: false,
      now: () => currentTime,
      frameIntervalMs: 0,
      burstDurationMs: 50,
    });

    lifecycle.setMode("speaking");
    queued.get(1)!(10_000);
    queued.delete(1);
    currentTime = 1_051;
    queued.get(2)!(10_016);

    expect(draws).toEqual([{ progress: 0, timestamp: 10_000 }]);
    lifecycle.dispose();
  });

  it("does not schedule reduced-motion or hidden surfaces", () => {
    let requests = 0;
    const lifecycle = createCircePresenceLifecycle({
      requestFrame: () => ++requests,
      cancelFrame: () => undefined,
      draw: () => undefined,
      visible: false,
      reducedMotion: false,
    });
    lifecycle.setMode("speaking");
    lifecycle.setVisible(true);
    lifecycle.setReducedMotion(true);
    expect(requests).toBe(1);
    lifecycle.dispose();
  });
});
