import {
  circeClientActionBooleanArg,
  circeClientActionTextArg,
  type CirceClientActionCapabilities,
  type CirceClientActionExecutor,
  type CirceClientActionExecutors,
} from "@circe/client-runtime/circe/clientActions";
import type { CirceClientToolName } from "@circe/contracts";
import { circeWebsiteUrl } from "@circe/core/website";

/**
 * The web/desktop client executor table. The node authorizes a bounded
 * action; this table performs it on the user's device and reports a real
 * result. A tool with no platform API is simply absent from the advertised
 * capabilities, so the classifier never offers it and the user never hears a
 * device-refusal.
 */

const openWebsite: CirceClientActionExecutor = async (args) => {
  const value = circeClientActionTextArg(args, "website");
  if (value === undefined) {
    return { status: "failed", speech: "I didn't catch which site to open." };
  }
  // The node already grounded the target in the user's own utterance; this
  // self-check keeps a tampered payload from launching an unheard address.
  const safe = circeWebsiteUrl(value, value);
  if (safe === null) return { status: "failed", speech: `I couldn't open ${value}.` };
  const bridge = window.desktopBridge;
  if (bridge !== undefined) {
    try {
      return (await bridge.openExternal(safe))
        ? { status: "ok", speech: `Opening ${value}.` }
        : { status: "failed", speech: `I couldn't open ${value}.` };
    } catch {
      return { status: "failed", speech: `I couldn't open ${value}.` };
    }
  }
  const opened = window.open(safe, "_blank");
  if (opened === null) {
    return { status: "failed", speech: "The browser blocked the new tab." };
  }
  opened.opener = null;
  opened.focus();
  return { status: "ok", speech: `Opening ${value}.` };
};

const firstMediaElement = (): HTMLMediaElement | null =>
  document.querySelector<HTMLMediaElement>(
    "audio:not([data-circe-ignore]), video:not([data-circe-ignore])",
  );

const adjustVolume = (element: HTMLMediaElement, delta: number): void => {
  element.volume = Math.min(1, Math.max(0, element.volume + delta));
};

const media: CirceClientActionExecutor = (args) => {
  const action = circeClientActionTextArg(args, "action");
  if (action === undefined)
    return { status: "failed", speech: "I didn't catch the media command." };
  const element = firstMediaElement();
  if (element === null) {
    return { status: "failed", speech: "I couldn't find anything playing to control." };
  }
  switch (action) {
    case "play":
      void element.play().catch(() => undefined);
      return { status: "ok", speech: "Playing." };
    case "pause":
      element.pause();
      return { status: "ok", speech: "Paused." };
    case "mute": {
      const muted = circeClientActionBooleanArg(args, "muted");
      element.muted = muted ?? !element.muted;
      return { status: "ok", speech: element.muted ? "Muted." : "Unmuted." };
    }
    case "volume-up":
      adjustVolume(element, 0.1);
      return { status: "ok", speech: "Turning the volume up." };
    case "volume-down":
      adjustVolume(element, -0.1);
      return { status: "ok", speech: "Turning the volume down." };
    default:
      // next/previous have no generic browser control; the browser's own
      // media session owns them, so report honestly rather than guessing.
      return { status: "failed", speech: "This player doesn't expose skip controls here." };
  }
};

const clipboard: CirceClientActionExecutor = async (args) => {
  const action = circeClientActionTextArg(args, "action");
  if (action === "copy") {
    const text = circeClientActionTextArg(args, "text");
    if (text === undefined) return { status: "failed", speech: "I don't have anything to copy." };
    try {
      await navigator.clipboard.writeText(text);
      return { status: "ok", speech: "Copied." };
    } catch {
      return { status: "failed", speech: "The clipboard refused the copy." };
    }
  }
  if (action === "paste") {
    try {
      const text = await navigator.clipboard.readText();
      return {
        status: "ok",
        speech:
          text.trim().length === 0 ? "The clipboard is empty." : `Pasted: ${text.slice(0, 80)}`,
      };
    } catch {
      return { status: "failed", speech: "The clipboard refused to be read." };
    }
  }
  return { status: "failed", speech: "I didn't catch the clipboard command." };
};

export const circeClientActionExecutors: CirceClientActionExecutors = {
  "open-website": openWebsite,
  media,
  clipboard,
};

/**
 * Tools this client can run. Browser clients own the web launcher, clipboard,
 * and in-page media; the Electron host also drives browser and desktop
 * missions because a plain web tab cannot confirm or execute them. Task
 * lifecycle notifications are dispatched by the node from orchestration
 * events, so the model never asks a client to raise one.
 */
export function circeClientActionCapabilities(): CirceClientActionCapabilities {
  const tools: Array<CirceClientToolName> = ["open-website", "clipboard", "media"];
  if (typeof window !== "undefined" && window.desktopBridge !== undefined) {
    tools.push("browse", "preview", "computer");
  }
  return { tools, candidates: {} };
}
