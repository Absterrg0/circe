/**
 * Chrome native messaging framing: a 4-byte little-endian length followed by
 * one UTF-8 JSON message. The host is launched by Chrome, so it reads and
 * writes these frames on stdin/stdout and never logs to stdout.
 */

export const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;

export function encodeNativeMessage(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

export interface NativeFrameDecodeResult {
  readonly messages: ReadonlyArray<unknown>;
  /** Bytes that do not yet form a complete frame. */
  readonly rest: Buffer;
}

export function decodeNativeFrames(buffer: Buffer): NativeFrameDecodeResult {
  const messages: Array<unknown> = [];
  let offset = 0;
  while (buffer.byteLength - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    if (length > MAX_NATIVE_MESSAGE_BYTES) {
      throw new Error("Native message exceeds the protocol limit.");
    }
    if (buffer.byteLength - offset - 4 < length) break;
    const payload = buffer.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length;
    messages.push(JSON.parse(payload.toString("utf8")));
  }
  return { messages, rest: buffer.subarray(offset) };
}
