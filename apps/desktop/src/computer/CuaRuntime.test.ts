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
