/**
 * Web entry for the shared GPT-Live controller.
 *
 * The session state machine, the browser transport seam, and the bounded
 * context builder live in `@circe/client-runtime/circe/liveVoiceController` so
 * the renderer and the mobile client cannot drift into two implementations of
 * the same protocol. This module stays as the web import path its callers,
 * tests, and the desktop bridge already use.
 */
export * from "@circe/client-runtime/circe/liveVoiceController";
