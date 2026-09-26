import type { CirceBotId, EnvironmentId } from "@circe/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const BotConversationView = lazy(async () => {
  const module = await import("../components/bots/BotConversationView");
  return { default: module.BotConversationView };
});

function BotRoute() {
  const { environmentId, botId } = Route.useParams();
  return (
    <Suspense fallback={null}>
      <BotConversationView
        key={`${environmentId}/${botId}`}
        environmentId={environmentId as EnvironmentId}
        botId={botId as CirceBotId}
      />
    </Suspense>
  );
}

export const Route = createFileRoute("/bots/$environmentId/$botId")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: BotRoute,
});
