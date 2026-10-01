// @effect-diagnostics globalTimers:off - this suite drives a real unix socket; the waits must
// elapse against the live event loop rather than virtual time.
// @effect-diagnostics globalDate:off - the same live waits measure real elapsed time.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ComputerHostEvent } from "@circe/contracts";

import { ComputerHostTransport, ComputerHostTransportError } from "./ComputerHostTransport.ts";
import { startFakeHost } from "./ComputerHostTestkit.testkit.ts";

const waitFor = async (check: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("Condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("ComputerHostTransport", () => {
  it.live("greets the host, dispatches calls, and receives events", () =>
    Effect.promise(async () => {
      const host = await startFakeHost();
      const events: ComputerHostEvent[] = [];
      const transport = new ComputerHostTransport({
        bootstrap: host.bootstrap,
        platform: "linux",
        onEvent: (event) => events.push(event),
      });
      try {
        transport.start();
        await waitFor(() => transport.connected && host.hellos.length > 0);
        expect(host.hellos[0]).toMatchObject({
          platform: "linux",
          capability: host.bootstrap.capability,
        });

        host.setToolResult("list_windows", {
          isError: false,
          degraded: false,
          effect: "verified",
          text: "windows",
          structured: { windows: [] },
          images: [],
        });
        const result = await transport.callTool({
          missionId: "m1",
          tool: "list_windows",
          args: {},
        });
        expect(result.effect).toBe("verified");
        expect(result.structured).toEqual({ windows: [] });
        expect(host.requests.at(-1)).toMatchObject({
          method: "call",
          missionId: "m1",
          tool: "list_windows",
        });

        host.pushEvent({ event: "input-interrupted", missionId: "m1" });
        await waitFor(() => events.length === 1);
        expect(events[0]).toMatchObject({ event: "input-interrupted", missionId: "m1" });
      } finally {
        transport.stop();
        await host.close();
      }
    }),
  );

  it.live("rejects requests while disconnected", () =>
    Effect.promise(async () => {
      const host = await startFakeHost();
      const transport = new ComputerHostTransport({
        bootstrap: host.bootstrap,
        platform: "linux",
      });
      try {
        await expect(
          transport.callTool({ missionId: "m1", tool: "list_windows" }),
        ).rejects.toBeInstanceOf(ComputerHostTransportError);
      } finally {
        transport.stop();
        await host.close();
      }
    }),
  );

  it.live("reconnects after the host drops the connection", () =>
    Effect.promise(async () => {
      const host = await startFakeHost();
      const events: ComputerHostEvent[] = [];
      const transport = new ComputerHostTransport({
        bootstrap: host.bootstrap,
        platform: "linux",
        onEvent: (event) => events.push(event),
      });
      try {
        transport.start();
        await waitFor(() => transport.connected);
        host.dropConnection();
        await waitFor(() => !transport.connected);
        await waitFor(() => transport.connected);
        const result = await transport.callTool({ missionId: "m1", tool: "list_windows" });
        expect(result.effect).toBe("verified");
      } finally {
        transport.stop();
        await host.close();
      }
    }),
  );
});
