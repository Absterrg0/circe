# Grok Bots

Circe lists the named bots from Grok Bot in the **Bots** group at the top of the sidebar. Pick one to send it a message. The bot answers with its own tools, permissions, and Grok history, and its reply shows up in the same conversation.

## Connect a bot

Grok Bot has to run on a machine where Circe runs as a Full or Headless node. Controller nodes don't run agents, so they never list bots.

Circe looks for the Grok Bot gateway file at `~/agent-data/gateway.json`. If Grok Bot keeps it somewhere else, start Circe with `CIRCE_GROK_GATEWAY` set to that path. The file holds a local credential for the gateway. Circe reads it on that machine only and never sends it to other devices.

Bots on every connected machine appear in the sidebar. With more than one machine, each row names the machine the bot runs on. Circe doesn't check for new bots in the background. Use the refresh button next to **Bots** after you add one in Grok.

## Send a message

Type in the box at the bottom of the bot's page and press Enter. Shift+Enter adds a new line.

Grok's gateway accepts the message but doesn't return the answer. Circe adds a short note to each message asking the bot to post its answer back to this machine when it finishes. Until then the message reads **Delivered · waiting for** the bot, and the sidebar shows **Waiting** on that bot's row. Long tasks can take a while.

Your message and the bot's reply also appear in the bot's own conversation in Grok. Messages you send from the Grok app itself don't show up in Circe.

## Ask Circe to message a bot

You can also go through Circe by voice or text, for example "ask YT desk for three video ideas". Circe knows your bots by name. While a bot's page is open, "it" and "this" mean that bot, so "tell it to make them shorter" goes to the same bot. When you send a message through Circe, it tells you when the bot replies. A message typed on the bot's page shows its reply there. Either way, Circe tells you if the bot fails.

Circe can't stop a bot or approve something for it. Do that in Grok.

## When a reply doesn't arrive

- **Not delivered**: Circe couldn't hand the message to Grok Bot, or Grok rejected it. The reason shows under the message. If Circe can't tell whether Grok received it, it says so. Check the bot's conversation in Grok before you send it again.
- **No reply**: the bot didn't answer within six hours, or you chose **Stop waiting**. Circe stops listening for that answer. The bot may still be working in Grok, and stopping here doesn't stop it there.

## Clear a conversation

The trash button in the bot's header deletes this machine's record of the conversation. The bot keeps its own history in Grok.

## If a machine goes offline

A bot on a disconnected machine stays in the sidebar, dimmed and marked **Offline**, and you can't send to it until the machine reconnects. Circe never sends the message to a bot on another machine instead.
