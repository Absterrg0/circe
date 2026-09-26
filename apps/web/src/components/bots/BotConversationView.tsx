import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@circe/client/state/runtime";
import {
  CIRCE_BOT_MESSAGE_MAX_CHARS,
  type CirceBotId,
  type CirceBotMessage,
  type CirceBotMessageId,
  type CirceBotUserMessage,
  type EnvironmentId,
} from "@circe/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { ArrowUpIcon, CircleAlertIcon, Trash2Icon, WifiOffIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { isElectron } from "../../env";
import { randomUUID } from "../../lib/utils";
import { circeBotsEnvironment } from "../../state/circeBots";
import { useEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { circeErrorMessage } from "../circe/CirceManager.logic";
import "../circe/circe-surfaces.css";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BotAvatar } from "./SidebarBots";

/** Grow the composer with its text, up to the CSS max height. */
function fitComposer(textarea: HTMLTextAreaElement | null, text: string): void {
  if (textarea === null) return;
  textarea.style.height = "auto";
  if (text.length > 0) textarea.style.height = `${textarea.scrollHeight}px`;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function sentAt(message: CirceBotMessage): string {
  const date = new Date(message.createdAt);
  return Number.isNaN(date.getTime()) ? "" : timeFormat.format(date);
}

/** Status line under a sent message; text, not color, carries the state. */
function deliveryLabel(message: CirceBotUserMessage, botName: string): string {
  switch (message.delivery) {
    case "sending":
      return `Sending to ${botName}`;
    case "waiting":
      return `Delivered · waiting for ${botName}`;
    case "answered":
      return "Answered";
    case "failed":
      return "Not delivered";
    case "expired":
      return "No reply";
  }
}

function UserMessage(props: {
  readonly message: CirceBotUserMessage;
  readonly botName: string;
  readonly onStopWaiting: (messageId: CirceBotMessageId) => void;
}) {
  const { message } = props;
  const failed = message.delivery === "failed" || message.delivery === "expired";
  return (
    <div className="circe-bot-msg" data-role="user">
      <div className="circe-bot-msg__body">{message.text}</div>
      <span className="circe-bot-status" data-tone={failed ? "error" : undefined}>
        {failed ? <CircleAlertIcon aria-hidden className="size-3.5" /> : null}
        {sentAt(message)} · {deliveryLabel(message, props.botName)}
      </span>
      {message.error ? (
        <span className="circe-bot-status" data-tone="error">
          {message.error}
        </span>
      ) : null}
      {message.delivery === "waiting" || message.delivery === "sending" ? (
        <span className="circe-bot-status">
          <button type="button" onClick={() => props.onStopWaiting(message.messageId)}>
            Stop waiting
          </button>
        </span>
      ) : null}
    </div>
  );
}

function PendingReply(props: { readonly botId: string; readonly botName: string }) {
  return (
    <div className="circe-bot-pending" role="status">
      <BotAvatar botId={props.botId} name={props.botName} size="md" />
      <span className="circe-bot-dots" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      <span>{props.botName} is working. The answer arrives here when it finishes.</span>
    </div>
  );
}

export function BotConversationView(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: CirceBotId;
}) {
  const environment = useEnvironment(props.environmentId);
  const online = environment?.connection.phase === "connected";
  const nodeLabel = environment?.serverConfig?.environment.label ?? environment?.label ?? "Unknown";
  const rosterResult = useAtomValue(
    circeBotsEnvironment.roster({ environmentId: props.environmentId, input: {} }),
  );
  const conversationResult = useAtomValue(
    circeBotsEnvironment.conversation({
      environmentId: props.environmentId,
      input: { botId: props.botId },
    }),
  );
  const roster = Option.getOrNull(AsyncResult.value(rosterResult));
  const conversation = Option.getOrNull(AsyncResult.value(conversationResult));
  const summary = roster?.bots.find((candidate) => candidate.bot.botId === props.botId) ?? null;
  const botName = summary?.bot.name ?? props.botId;
  const messages = conversation?.messages ?? [];

  const send = useAtomCommand(circeBotsEnvironment.send, { reportFailure: false });
  const stopWaiting = useAtomCommand(circeBotsEnvironment.stopWaiting, { reportFailure: false });
  const clear = useAtomCommand(circeBotsEnvironment.clearConversation, { reportFailure: false });

  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view as the conversation grows.
  const messageCount = messages.length;
  useLayoutEffect(() => {
    if (messageCount > 0) endRef.current?.scrollIntoView({ block: "end" });
  }, [messageCount]);

  const gateway = roster?.gateway ?? null;
  const canSend = online && gateway?.status === "ready" && summary?.listed === true && !sending;
  const waiting = messages.some(
    (message) =>
      message.role === "user" && (message.delivery === "waiting" || message.delivery === "sending"),
  );

  const submit = async () => {
    const text = draft.trim();
    if (text.length === 0 || !canSend) return;
    setSending(true);
    setError(null);
    setDraft("");
    fitComposer(textareaRef.current, "");
    const result = await send({
      environmentId: props.environmentId,
      input: { botId: props.botId, messageId: randomUUID() as CirceBotMessageId, text },
    });
    setSending(false);
    if (result._tag === "Failure") {
      // Nothing was recorded, so the words go back into the composer.
      setDraft(text);
      requestAnimationFrame(() => fitComposer(textareaRef.current, text));
      setError(circeErrorMessage(squashAtomCommandFailure(result)));
    }
  };

  const onStopWaiting = (messageId: CirceBotMessageId) => {
    void stopWaiting({
      environmentId: props.environmentId,
      input: { botId: props.botId, messageId },
    });
  };

  const onClear = async () => {
    const confirmed =
      (await requestConfirmDialog(
        `Clear this node's record of your conversation with ${botName}? The bot keeps its own history in Grok.`,
        { variant: "destructive" },
      )) ?? true;
    if (!confirmed) return;
    void clear({ environmentId: props.environmentId, input: { botId: props.botId } });
  };

  const notice = !online
    ? {
        icon: <WifiOffIcon className="size-4 shrink-0" />,
        text: `${nodeLabel} is offline, so ${botName} cannot be reached until it reconnects.`,
      }
    : gateway?.status === "unavailable"
      ? { icon: <CircleAlertIcon className="size-4 shrink-0" />, text: gateway.message }
      : summary !== null && !summary.listed
        ? {
            icon: <CircleAlertIcon className="size-4 shrink-0" />,
            text: `Grok Bot no longer lists ${botName} on ${nodeLabel}. You can still read this conversation.`,
          }
        : null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <WorkspaceBreadcrumb ariaLabel="Bot breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem>
              <span className="text-muted-foreground">Bots</span>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="min-w-0">
              <span className="truncate font-medium">{botName}</span>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="ms-auto flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Clear conversation"
                    disabled={messages.length === 0 || !online}
                    onClick={() => void onClear()}
                  />
                }
              >
                <Trash2Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Clear conversation</TooltipPopup>
            </Tooltip>
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-[var(--chat-content-max-width)] px-5 sm:px-6">
            <header className="circe-bot-hero">
              <BotAvatar botId={props.botId} name={botName} size="lg" />
              <div className="min-w-0">
                <h1 className="truncate">{botName}</h1>
                <p>
                  Grok Bot on {nodeLabel}
                  {summary?.bot.description ? ` · ${summary.bot.description}` : ""}
                </p>
              </div>
            </header>
            {notice ? (
              <div className="circe-bot-note mb-4" data-tone="warning" role="status">
                {notice.icon}
                <span>{notice.text}</span>
              </div>
            ) : null}
            {conversation !== null && messages.length === 0 ? (
              <div className="circe-bot-empty">
                <BotAvatar botId={props.botId} name={botName} size="md" />
                <h2>Start a conversation with {botName}</h2>
                <p className="max-w-sm">
                  Your message goes to the bot in Grok with its own tools and permissions. Its
                  answer comes back here when it finishes, which can take a while for long tasks.
                </p>
              </div>
            ) : null}
            <div className="circe-bot-thread" aria-live="polite">
              {messages.map((message) =>
                message.role === "user" ? (
                  <UserMessage
                    key={message.messageId}
                    message={message}
                    botName={botName}
                    onStopWaiting={onStopWaiting}
                  />
                ) : (
                  <div
                    key={message.messageId}
                    className="circe-bot-msg"
                    data-role="bot"
                    data-outcome={message.outcome}
                  >
                    <BotAvatar botId={props.botId} name={botName} size="md" />
                    <div className="circe-bot-msg__body">
                      {message.outcome === "error" ? (
                        <p className="mb-1 text-xs font-medium text-destructive-foreground">
                          {botName} could not finish
                        </p>
                      ) : null}
                      <ChatMarkdown
                        text={message.text}
                        cwd={undefined}
                        environmentId={props.environmentId}
                      />
                      <span className="circe-bot-status mt-1">{sentAt(message)}</span>
                    </div>
                  </div>
                ),
              )}
              {waiting && online ? <PendingReply botId={props.botId} botName={botName} /> : null}
            </div>
            <div ref={endRef} />
          </div>
        </ScrollArea>

        <div className="mx-auto w-full max-w-[var(--chat-content-max-width)] px-5 pb-5 sm:px-6">
          {error ? (
            <p className="circe-bot-status mb-2" data-tone="error" role="alert">
              <CircleAlertIcon aria-hidden className="size-3.5" />
              {error}
            </p>
          ) : null}
          <div className="circe-bot-composer">
            <textarea
              ref={textareaRef}
              rows={1}
              aria-label={`Message ${botName}`}
              placeholder={canSend || sending ? `Message ${botName}` : `${botName} is unavailable`}
              value={draft}
              autoFocus
              maxLength={CIRCE_BOT_MESSAGE_MAX_CHARS}
              onChange={(event) => {
                setDraft(event.target.value);
                fitComposer(event.currentTarget, event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <Button
              size="icon-sm"
              className="rounded-full"
              aria-label={`Send to ${botName}`}
              disabled={!canSend || draft.trim().length === 0}
              onClick={() => void submit()}
            >
              <ArrowUpIcon className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
