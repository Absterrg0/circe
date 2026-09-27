import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { getCirceCommandState, onCirceCommandState } from "../../circeBus";
import { isElectron } from "../../env";
import { isMacPlatform } from "../../lib/utils";
import { getCirceLiveVoiceUiState, subscribeCirceLiveVoice } from "../circe/CirceLiveVoice.bridge";
import { CirceOrb, type CirceOrbState } from "../circe/CirceOrb";
import { useSidebar } from "../ui/sidebar";

/**
 * The sidebar's way into the command center. The orb mirrors Circe's live
 * presence from the same buses the command center reads, so it only moves
 * while Circe is listening or working.
 */
export function CirceCommandLauncher() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const active = useLocation({ select: (location) => location.pathname === "/circe" });
  const [voice, setVoice] = useState(getCirceLiveVoiceUiState);
  const [command, setCommand] = useState(getCirceCommandState);
  useEffect(() => subscribeCirceLiveVoice(() => setVoice(getCirceLiveVoiceUiState())), []);
  useEffect(() => onCirceCommandState(setCommand), []);

  const state: CirceOrbState =
    voice.active && voice.status === "live"
      ? "listening"
      : command.busy
        ? "working"
        : command.awaitingAnswer
          ? "attention"
          : "idle";
  const label =
    state === "listening"
      ? "Circe is listening"
      : state === "working"
        ? "Circe is working"
        : state === "attention"
          ? "Circe needs your answer"
          : "Ask Circe";
  // Desktop binds the chord to global voice, so the hint is web-only.
  const shortcut = isElectron ? null : isMacPlatform(navigator.platform) ? "⌘⇧J" : "Ctrl⇧J";

  return (
    <button
      type="button"
      className="circe-launcher"
      data-active={active ? "true" : "false"}
      aria-label="Open the Circe command center"
      onClick={() => {
        if (isMobile) setOpenMobile(false);
        void navigate({ to: "/circe" });
      }}
    >
      <CirceOrb state={state} size="md" />
      <span className="circe-launcher__label">{label}</span>
      {shortcut ? <kbd>{shortcut}</kbd> : null}
    </button>
  );
}
