import { describe, expect, it } from "vite-plus/test";

import { CuaRuntime } from "./CuaRuntime.ts";

/** A driver module whose drivers record their lifecycle; `available` flips one off. */
const fakeModule = () => {
  const events: string[] = [];
  const drivers: Array<{ available: boolean }> = [];
  const module = {
    CuaDriver: {
      create: () => {
        const index = drivers.length + 1;
        const state = { available: true };
        drivers.push(state);
        events.push(`create ${index}`);
        return {
          isAvailable: () => state.available,
          callTool: async (name: string) => {
            events.push(`call ${name} on ${index}`);
            return {};
          },
          shutdown: async () => {
            events.push(`shutdown ${index}`);
          },
          uniffiDestroy: () => {
            events.push(`destroy ${index}`);
          },
        };
      },
    },
  };
  return { module, events, drivers };
};

describe("CuaRuntime", () => {
  it.each([{ DISPLAY: ":0" }, { WAYLAND_DISPLAY: "wayland-0", CUA_DRIVER_RS_ENABLE_WAYLAND: "0" }])(
    "preserves an X11 session or explicit Wayland override: %j",
    async (environment) => {
      const env: NodeJS.ProcessEnv = { ...environment };
      const prior = env.CUA_DRIVER_RS_ENABLE_WAYLAND;
      const fake = fakeModule();
      const runtime = new CuaRuntime({ environment: env, load: async () => fake.module });
      try {
        await runtime.callTool("list_windows", {});
        expect(env.CUA_DRIVER_RS_ENABLE_WAYLAND).toBe(prior);
      } finally {
        await runtime.shutdown();
      }
    },
  );
  it("enables native Wayland discovery before loading the driver on a mixed Wayland/XWayland desktop", async () => {
    const environment: NodeJS.ProcessEnv = { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" };
    const fake = fakeModule();
    const runtime = new CuaRuntime({
      environment,
      load: async () => {
        expect(environment.CUA_DRIVER_RS_ENABLE_WAYLAND).toBe("1");
        return fake.module;
      },
    });
    try {
      await runtime.callTool("list_windows", {});
    } finally {
      await runtime.shutdown();
    }
  });

  it("cannot create a driver when shutdown overtakes its import", async () => {
    const fake = fakeModule();
    let finishLoad!: (module: unknown) => void;
    const runtime = new CuaRuntime({
      load: () =>
        new Promise((resolve) => {
          finishLoad = resolve;
        }),
    });
    const pending = runtime.callTool("list_apps", {});
    const rejected = expect(pending).rejects.toThrow("shut down");
    await runtime.shutdown();
    finishLoad(fake.module);
    await rejected;
    expect(fake.events).toEqual([]);
    expect(runtime.state).toBe("stopped");
    await expect(runtime.metadata()).rejects.toThrow("shut down");
    await expect(runtime.toolManifest()).rejects.toThrow("shut down");
    await expect(runtime.callTool("install_extension", {})).rejects.toThrow("shut down");
    expect(fake.events).toEqual([]);
  });

  it("releases a driver that stopped being available before creating the next", async () => {
    const fake = fakeModule();
    const runtime = new CuaRuntime({ load: async () => fake.module });
    await runtime.callTool("list_apps", {});
    fake.drivers[0]!.available = false;
    await runtime.callTool("list_apps", {});
    expect(fake.events).toEqual([
      "create 1",
      "call list_apps on 1",
      "shutdown 1",
      "destroy 1",
      "create 2",
      "call list_apps on 2",
    ]);
  });

  it("shares one replacement between callers that find the driver gone at the same time", async () => {
    const fake = fakeModule();
    const runtime = new CuaRuntime({ load: async () => fake.module });
    await runtime.callTool("list_apps", {});
    fake.drivers[0]!.available = false;
    await Promise.all([runtime.callTool("status", {}), runtime.callTool("list_windows", {})]);
    expect(fake.events.filter((event) => event.startsWith("create"))).toEqual([
      "create 1",
      "create 2",
    ]);
    expect(fake.events.filter((event) => event.startsWith("destroy"))).toEqual(["destroy 1"]);
  });
});
