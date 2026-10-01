# Live conversation runbook

Maintainer setup, verification, and troubleshooting for the GPT-Live speech-to-speech mode.
The user-facing description lives in `docs/user/circe.md`.

## What runs where

- The browser/desktop renderer owns microphone and speaker audio over WebRTC. It creates the SDP
  offer and the `oai-events` data channel.
- Linked nodes create cloud sessions through the relay using their environment credential. The
  deployment OpenAI key stays on the relay. Unlinked nodes use their own configured OpenAI key.
- Cloud sessions close through the node and relay. The relay calls OpenAI's Live hangup endpoint
  and frees the reservation only after success or the exact `session_id_not_found` response.
- GPT-Live handles speech and delegation. On `session.delegation.created`, the renderer submits the
  accumulated user transcript through the ordinary Circe voice submission queue, so the Director,
  grounding, clarification, and provider adapters behave exactly as typed turns.
- Backend feedback and task presentations return as `session.commentary.append` (spoken) and
  `session.thinking.append` (quiet progress). While a session is active, the browser report lane is
  bypassed.

## Configure a node

Link the node to Circe Mesh to use cloud voice. The node link controls availability; signing
out of a renderer does not remove the node link. A linked node reports relay errors directly
and does not silently switch to a local key.

For an unlinked node:

1. Open **Machines**, pick the node, and find **Live conversation** under its node settings.
2. Paste an OpenAI project API key, confirm or change the model (default `gpt-live-1`) and voice
   (default `marin`), then **Save**.
3. The key is written to the node secret store as `circe-live-voice-openai-api-key`
   (`<userdata>/secrets/circe-live-voice-openai-api-key.bin`). `settings.json` keeps only the
   redaction marker for `circeLiveVoice.apiKey`. In the parallel `Circe-realtime` build the base
   directory is `~/.circe-realtime`, so the file is
   `~/.circe-realtime/userdata/secrets/circe-live-voice-openai-api-key.bin`.
4. **Remove key** clears the stored secret. A linked node can still use cloud voice.

`Live conversation` requires the Full or Controller preset. Headless nodes
answer `capability-unavailable`. Live voice needs no local speech models: the
session handles listening and speaking end to end. In a realtime-only build there
are no hold-to-speak controls, so use live conversation or typing there. `gpt-live-1` is priced per
minute of session duration, billed by the second, and backend provider usage is billed separately.

Required OpenAI project access: GPT-Live in the API, `v1/live/sessions`, WebRTC transport. Tier 1
allows 25 concurrent sessions.

## Manual acceptance

Voice tests prove protocol wiring and transcript handling. They cannot prove a real microphone,
WebRTC negotiation, audio routing, or the model's delegation behavior. Before calling a release
candidate good, do this by hand on the target desktop:

1. Link the node to Circe Mesh without a local API key. Repeat with an unlinked node and its own key.
2. Open Home and press the microphone button. Expect it to highlight, its label to move from
   **Connecting voice** to **End voice conversation**, and the browser to prompt for microphone
   permission once.
3. Tap `Ctrl+Shift+J` (`Command+Shift+J` on macOS). Expect the tray item to read **Start live conversation**
   and the tap to start a session; tap again to end it.
4. On Linux, the first use of the global shortcut may show a desktop-portal approval dialog for the
   app; approve it once.
5. Say a conversational sentence ("what do you think about this approach"). Expect a spoken reply
   without a task being created.
6. Say a command ("start a task to fix the failing tests" or "what's the status"). Expect the model
   to acknowledge, then hear the Director's grounded acknowledgement or clarification, not an
   invented target.
7. Interrupt mid-reply. Expect speech to stop and the model to yield.
8. Let the task finish. Expect the completion or failure presentation to be spoken without a second
   report voice.
9. Press **End conversation** or tap the shortcut. Expect the microphone indicator to clear; the OS
   no longer shows the browser using the microphone. Confirm the session id reports usage on the
   OpenAI dashboard.

Data-channel events can be observed in the browser devtools WebRTC internals or by temporary
`console.debug` in `CirceLiveVoice.logic.ts`.

## Troubleshooting

- **"Add an OpenAI API key on this node to use live voice."** The node is unlinked and has no key.
  Link it to Circe Mesh or save a key through **Live conversation**.
- **"This account already has an active live conversation."** End the existing conversation. If a
  previous client lost its session, follow the reservation recovery procedure below.
- **"Live voice is unavailable on this Circe node."** The node preset is Headless, or the node was
  built before this feature. Check the node's preset.
- **"The GPT-Live session could not be created."** The upstream request failed. Check key validity,
  project access to GPT-Live, outbound HTTPS from the node, and the OpenAI status page. Server logs
  carry the cause with the key redacted; client errors never include the key or response body.
- **Microphone stays off / no reply audio.** WebRTC needs a secure context (`https` or `localhost`)
  and microphone permission. Autoplay policies can require one click on the page after the session
  starts.
- **The live voice repeats itself or a report is stale.** Check whether the presentation arrived for
  the session's origin. Reports are live-only; a reconnect does not replay them, and the durable task
  remains the source of truth.

## Cost and failure behavior

- A WebRTC session creation bills 15 seconds of voice duration during initialization, credited
  against the running session. Ending the session cleanly (`session.close` then `session.closed`)
  finalizes usage. A dropped connection leaves final usage unconfirmed.
- The client ends a session after 60 seconds without user speech and after 10 minutes at most, and
  releases the microphone immediately on stop. Those client timers are the fast path.
- The node and the relay also own server-side timers, so a killed or sleeping renderer cannot leave
  a session billing. While a session is live the renderer renews a server-side lease through the
  node every 20 seconds; the node closes any session whose lease lapses (three missed renewals) or
  whose 12-minute ceiling passes. Cloud sessions close over their original authenticated relay
  route; local-key sessions close straight against the provider with the node's key. A closure
  counts once `POST /v1/live/sessions/{session_id}/hangup` answers 2xx, answers
  `session_id_not_found`, or answers the empty 404 the provider sends for a session it has already
  dropped. Leases for both routes are persisted, so a node restart still closes a session whose
  renderer was killed: a recovered session gets one lease window of grace for a live renderer to
  resume heartbeats, a session whose ceiling already passed closes on startup, and a session the
  node cannot close (no local key, or a cloud session on an unlinked node) keeps its durable record
  for the next attempt.
- When the relay answers a cloud create with "session in use", the node frees only its own cloud
  sessions that no renderer is renewing (recovered and not yet reclaimed, or lapsed) and retries
  once. It never ends a session that is still being renewed, and it cannot free a slot held by
  another device.
- The relay independently sweeps expired cloud reservations on its scheduled cron, across every
  account, so billing stays bounded even if the node itself dies.
- If the data channel closes unexpectedly, the renderer reports the failure and stops
  automatically. Pressing **Live conversation** starts a fresh session; work already accepted by the
  Director continues on the node.

## How long a cloud reservation can hold an account

The relay reserves one cloud session per account before calling upstream, and the reservation is
what answers "session in use". Two rules decide when it goes away:

- Inside its ceiling, only confirmed closure frees it. A session that may still be live is never
  replaced on a guess. A reservation with no session id (creation was interrupted) cannot be closed
  or released by id, so it waits for the ceiling.
- Past its ceiling, it is removed regardless. The ceiling is the node's 12-minute session limit plus
  a 3-minute margin, counted from creation. Nothing extends it: not an unknown session id, a
  provider that never confirms, or a sweep that keeps deferring the retry. The next create for the
  account and the scheduled sweep both apply it. A removal without confirmed closure logs
  `Cloud voice reservation removed at its ceiling without confirmed closure` with the user,
  reservation, and session ids.

A failed create frees the slot at once, including when the outcome is unknown. A session whose
answer never reached a client has no peer and cannot carry a conversation, so holding the account
for it only turns one provider timeout into a blocked microphone.

The ceiling exists because of an incident: a session nobody released, a provider answering an empty
404 that the relay did not accept as closure, and a sweep that pushed the retry five minutes ahead
on every pass. The account stayed blocked for a day until the row was deleted by hand. Accepting the
empty 404 fixes that case; the ceiling is what makes the whole class impossible, including a
provider that renames the hangup route or rejects the deployment key.

Accepting the empty 404 has a cost. The provider sends the same answer for any path it cannot
route, so a renamed hangup route would read as closure while sessions stay open until their client
disconnects. Watch for sessions that outlive their conversation if the provider changes that API.

On the node, release is idempotent: releasing an unknown session id on an unlinked node succeeds
without contacting the relay, so a stale renderer can never wedge future sessions. Pending cloud
releases retry on the next cloud session create and never block local-key sessions.

Ship the node, relay, and renderer together. Older renderers ignore the `releaseRequired` flag, so a
cloud session started by an old client is never released and its reservation lasts until the
ceiling.

To see what holds an account, query the relay database read-only, binding the account id as `$1`:

```sql
SELECT user_id, reservation_id, session_id, environment_id, created_at, expires_at
FROM relay_live_voice_sessions
WHERE user_id = $1;
```

`created_at` plus 15 minutes is when the row stops blocking. `expires_at` is only the next closure
attempt. A row older than that means the relay running is older than this document.
