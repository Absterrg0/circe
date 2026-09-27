import { WS_METHODS } from "@circe/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@circe/client/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Grok Bots are node-owned, so every atom here is keyed by environment. The
 * roster stream is opened by the sidebar and the conversation stream by the
 * open bot view; both close shortly after nothing reads them, and the server
 * never polls the gateway on their behalf.
 */
export const circeBotsEnvironment = {
  roster: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:circe:bots",
    tag: WS_METHODS.subscribeCirceBots,
    idleTtlMs: 30_000,
  }),
  conversation: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:circe:bot-conversation",
    tag: WS_METHODS.subscribeCirceBotConversation,
    idleTtlMs: 30_000,
  }),
  refresh: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:bots:refresh",
    tag: WS_METHODS.circeBotsRefresh,
  }),
  send: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:bots:send",
    tag: WS_METHODS.circeBotSend,
  }),
  stopWaiting: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:bots:stop-waiting",
    tag: WS_METHODS.circeBotStopWaiting,
  }),
  clearConversation: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:bots:clear",
    tag: WS_METHODS.circeBotClearConversation,
  }),
};
