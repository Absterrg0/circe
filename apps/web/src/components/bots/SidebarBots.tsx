import { useAtomValue } from "@effect/atom-react";
import type { CirceBotSummary, EnvironmentId } from "@circe/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { RefreshCwIcon } from "lucide-react";
import { memo, useCallback, useEffect } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useEnvironments } from "../../state/environments";
import { circeBotsEnvironment } from "../../state/circeBots";
import { useAtomCommand } from "../../state/use-atom-command";
import { SidebarSectionHeading } from "../sidebar/SidebarSectionHeading";
import { useSidebar } from "../ui/sidebar";
import { reportBotCount, useTotalBotCount } from "./botCounts";
import { botMonogram, botTint } from "./botIdentity";

const BOTS_COLLAPSED_KEY = "circe:sidebar:bots-collapsed";
const BOT_ROUTE = /^\/bots\/([^/]+)\/([^/]+)\/?$/;

export function BotAvatar(props: {
  readonly botId: string;
  readonly name: string;
  readonly size?: "sm" | "md" | "lg";
}) {
  return (
    <span
      aria-hidden
      className="circe-bot-avatar"
      data-size={props.size ?? "sm"}
      style={{ ["--bot-tint" as string]: botTint(props.botId) }}
    >
      {botMonogram(props.name)}
    </span>
  );
}

function botMeta(summary: CirceBotSummary, nodeLabel: string | null, online: boolean): string {
  const prefix = nodeLabel === null ? "" : `${nodeLabel} · `;
  if (!online) return `${prefix}Offline`;
  if (!summary.listed) return `${prefix}No longer in Grok Bot`;
  return `${prefix}${summary.lastMessagePreview ?? summary.bot.description ?? "Grok Bot"}`;
}

/** One node's bots. Mounted per node so each roster stream is independent. */
const NodeBots = memo(function NodeBots(props: {
  readonly environmentId: EnvironmentId;
  readonly nodeLabel: string | null;
  readonly online: boolean;
  readonly activeBotKey: string | null;
  readonly collapsed: boolean;
  readonly onOpen: (environmentId: EnvironmentId, botId: string) => void;
}) {
  const result = useAtomValue(
    circeBotsEnvironment.roster({ environmentId: props.environmentId, input: {} }),
  );
  const state = Option.getOrNull(AsyncResult.value(result));
  const bots = state?.bots ?? [];
  const count = bots.length;
  useEffect(() => {
    reportBotCount(props.environmentId, count);
  }, [count, props.environmentId]);
  useEffect(() => () => reportBotCount(props.environmentId, null), [props.environmentId]);

  return bots.map((summary) => {
    const key = `${props.environmentId}/${summary.bot.botId}`;
    return (
      <li key={key} className="list-none" hidden={props.collapsed}>
        <button
          type="button"
          className="circe-bot-row"
          data-active={props.activeBotKey === key ? "true" : "false"}
          data-offline={props.online ? "false" : "true"}
          onClick={() => props.onOpen(props.environmentId, summary.bot.botId)}
        >
          <BotAvatar botId={summary.bot.botId} name={summary.bot.name} />
          <span className="circe-bot-row__text">
            <span className="circe-bot-row__name">{summary.bot.name}</span>
            <span className="circe-bot-row__meta">
              {botMeta(summary, props.nodeLabel, props.online)}
            </span>
          </span>
          {summary.waiting > 0 && props.online ? (
            <span className="circe-bot-row__badge">Waiting</span>
          ) : null}
        </button>
      </li>
    );
  });
});

/**
 * The sidebar's Bots group: every Grok Bot on every connected node that runs
 * agents. A Controller node has no bots, so it is never subscribed.
 */
export function SidebarBotsSection() {
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const pathname = useLocation({ select: (location) => location.pathname });
  const routeMatch = BOT_ROUTE.exec(pathname);
  const activeBotKey =
    routeMatch === null
      ? null
      : `${decodeURIComponent(routeMatch[1]!)}/${decodeURIComponent(routeMatch[2]!)}`;
  const [collapsed, setCollapsed] = useLocalStorage(BOTS_COLLAPSED_KEY, false, Schema.Boolean);
  const total = useTotalBotCount();
  const refresh = useAtomCommand(circeBotsEnvironment.refresh, {
    reportFailure: false,
    reportDefect: false,
  });

  const nodes = environments.filter(
    (environment) =>
      environment.serverConfig?.environment.capabilities.circeNode?.execution !== false,
  );
  const multiNode = nodes.length > 1;

  const open = useCallback(
    (environmentId: EnvironmentId, botId: string) => {
      if (isMobile) setOpenMobile(false);
      void navigate({ to: "/bots/$environmentId/$botId", params: { environmentId, botId } });
    },
    [isMobile, navigate, setOpenMobile],
  );

  return (
    <>
      {/* The group appears once a bot exists; an empty heading only adds noise. */}
      {total > 0 ? (
        <SidebarSectionHeading
          label="Bots"
          count={total}
          collapsed={collapsed}
          onToggle={() => setCollapsed((value) => !value)}
          action={{
            label: "Look for bots again",
            icon: <RefreshCwIcon />,
            disabled: nodes.length === 0,
            onClick: () => {
              for (const node of nodes) {
                if (node.connection.phase === "connected") {
                  void refresh({ environmentId: node.environmentId, input: {} });
                }
              }
            },
          }}
        />
      ) : null}
      {nodes.map((node) => (
        // Rows stay mounted while collapsed so the heading count stays current.
        <NodeBots
          key={node.environmentId}
          environmentId={node.environmentId}
          nodeLabel={multiNode ? (node.serverConfig?.environment.label ?? node.label) : null}
          online={node.connection.phase === "connected"}
          activeBotKey={activeBotKey}
          collapsed={collapsed}
          onOpen={open}
        />
      ))}
    </>
  );
}
