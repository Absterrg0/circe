import { describe, expect, it } from "vite-plus/test";

import {
  decodeNativeFrames,
  encodeNativeMessage,
  MAX_NATIVE_MESSAGE_BYTES,
} from "./nativeFraming.ts";

describe("native messaging framing", () => {
  it("round-trips one message", () => {
    const encoded = encodeNativeMessage({ type: "hello", profileLabel: "Chrome" });
    const decoded = decodeNativeFrames(encoded);
    expect(decoded.messages).toEqual([{ type: "hello", profileLabel: "Chrome" }]);
    expect(decoded.rest.byteLength).toBe(0);
  });

  it("keeps a partial frame as rest instead of dropping bytes", () => {
    const encoded = encodeNativeMessage({ type: "snapshot" });
    const partial = encoded.subarray(0, encoded.byteLength - 2);
    const decoded = decodeNativeFrames(partial);
    expect(decoded.messages).toEqual([]);
    expect(decoded.rest.byteLength).toBe(partial.byteLength);
    const completed = decodeNativeFrames(
      Buffer.concat([decoded.rest, encoded.subarray(encoded.byteLength - 2)]),
    );
    expect(completed.messages).toEqual([{ type: "snapshot" }]);
  });

  it("decodes several frames in one chunk", () => {
    const first = encodeNativeMessage({ id: "req-1", type: "snapshot" });
    const second = encodeNativeMessage({ id: "req-2", type: "tab.detach" });
    const decoded = decodeNativeFrames(Buffer.concat([first, second]));
    expect(decoded.messages).toEqual([
      { id: "req-1", type: "snapshot" },
      { id: "req-2", type: "tab.detach" },
    ]);
  });

  it("refuses a frame above the protocol limit", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1, 0);
    expect(() => decodeNativeFrames(header)).toThrow();
  });
});
