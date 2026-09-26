# Circe bots

Grok Bots are not a provider adapter. A bot keeps its own Grok conversation, tools, and permissions, has no workspace or model selection, and is shared with the Grok app, so it doesn't fit the thread and turn model. The node records the exchange in `circe_bot_messages` and serves it over the `circe.bots.*` RPCs.

## The gateway does not return answers

The gateway (`apps/server/src/circe/bots/grokBotGateway.ts`) accepts a prompt and reports whether it was accepted. It never returns the bot's reply. Each prompt therefore ends with a one-time reply URL on the node's loopback port, `POST /api/circe/bot-replies/<token>`, and instructions to `curl` the answer there. That callback is the only thing that completes a message. The route accepts loopback callers only, because the bot and gateway always run on the node that prompted them.

The token stays on the row after an answer lands, so an identical retry from the bot gets `200` instead of a confusing `404`. A different second answer gets `409`. Closing the URL (stop waiting, the six-hour deadline, clearing the conversation) clears the token.

## Never prompt a bot twice

The client-generated message id is the gateway's `clientNonce`. When `sendPrompt` fails, the node asks `promptAcceptanceStatus` before reporting anything. If the gateway can't say (`unknown-durability`), the message is marked failed with an explicit "could not confirm" message and the reply URL stays open, so a late answer still lands. Do not add an automatic resend path.

## Bots in the Circe host layer

circe-core's host contract knows projects and threads, so `apps/server/src/circe/host/botPlaces.ts` gives each listed bot one of each under the same id, `bot:<botId>` (see `circeBotPlaceId` in the contracts). `start` and `deliver` on that id send the words to the bot; `stop`, `respond`, `close`, and `withdraw` refuse with a reason Circe reads back, because Circe cannot stop, approve for, or archive a Grok Bot. The thread's run state follows the latest message (waiting is running, an answer is idle, an error reply or a failed send is errored, and an expired message is idle with its reason so stopping the wait is not announced as a failure), and `CirceHostRuntime` refreshes circe-core on every bot change. That is what makes circe-core announce a bot's answer the same way it announces a finished agent. A failure to read the bots leaves them out of that turn's world and never hides coding work.

Clients map `bot:` ids in host `focus` and `navigate` to the bot page; the older Director path never sees them.

## Discovery and presets

The discovery file is `CIRCE_GROK_GATEWAY` or `~/agent-data/gateway.json`. It is re-read on every call because the gateway can restart on a new port. Its bearer token never leaves the node and never appears in errors. Nodes whose preset has no execution report `unsupported` and are never asked for a roster. The roster is read when a client subscribes or refreshes; nothing polls it. `circe_bots` keeps the last names seen, so a stored conversation stays readable while the gateway is down.
