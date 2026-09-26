import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The Circe host layer: one input in front of this node. The node interprets
 * each message against its own projects and threads and carries it out, so a
 * client only sends words and the screen it is showing.
 */

/** What is on screen when the message was sent; resolves "this", "it" and "here". */
export const CirceHostFocus = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
});
export type CirceHostFocus = typeof CirceHostFocus.Type;

export const CirceHostSayInput = Schema.Struct({
  utterance: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
  focus: Schema.optional(CirceHostFocus),
});
export type CirceHostSayInput = typeof CirceHostSayInput.Type;

/**
 * `acted`: carried out or answered. `asked`: Circe needs a choice and reads
 * the next message as the answer. `failed`: the node could not carry it out.
 * `unavailable`: the layer is off on this node; the client uses its own path.
 */
export const CirceHostSayResult = Schema.Struct({
  status: Schema.Literals(["acted", "asked", "failed", "unavailable"]),
  said: Schema.String,
  options: Schema.optional(Schema.Array(Schema.String)),
  /** Where the screen should go, when Circe opened something. */
  navigate: Schema.optional(CirceHostFocus),
  /** Threads the node created for the message. */
  started: Schema.Array(ThreadId),
});
export type CirceHostSayResult = typeof CirceHostSayResult.Type;

export const CirceHostNoticeSubscriptionInput = Schema.Struct({});
export type CirceHostNoticeSubscriptionInput = typeof CirceHostNoticeSubscriptionInput.Type;

/** Something Circe says on its own: a failure, a question, finished work the user is waiting for. */
export const CirceHostNotice = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
});
export type CirceHostNotice = typeof CirceHostNotice.Type;

/** One spoken message: the node transcribes it through Circe Mesh, then handles the words. */
export const CirceHostListenInput = Schema.Struct({
  audio: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000_000)),
  mimeType: Schema.Literals(["audio/webm", "audio/ogg", "audio/wav", "audio/mp4", "audio/mpeg"]),
  focus: Schema.optional(CirceHostFocus),
});
export type CirceHostListenInput = typeof CirceHostListenInput.Type;

export const CirceHostListenResult = Schema.Struct({
  ...CirceHostSayResult.fields,
  /** What Circe heard; empty when it heard no words. */
  heard: Schema.String,
});
export type CirceHostListenResult = typeof CirceHostListenResult.Type;

export const CirceHostSpeakInput = Schema.Struct({
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
});
export type CirceHostSpeakInput = typeof CirceHostSpeakInput.Type;

/** A reply as audio; `audio` is empty when the node cannot speak, and the client stays silent. */
export const CirceHostSpeakResult = Schema.Struct({
  audio: Schema.String,
  mimeType: Schema.Literal("audio/mpeg"),
});
export type CirceHostSpeakResult = typeof CirceHostSpeakResult.Type;
