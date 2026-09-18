import {
  circeClientActionTextArg,
  type CirceClientActionCapabilities,
  type CirceClientActionExecutor,
  type CirceClientActionExecutors,
} from "@circe/client-runtime/circe/clientActions";
import type { CirceClientToolName } from "@circe/contracts";
import { circeWebsiteUrl } from "@circe/core/website";
import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";

/**
 * The mobile client executor table. The node authorizes a bounded action;
 * this table runs it with the phone's own APIs and reports a real result. A
 * tool the platform cannot perform is left out of the advertised
 * capabilities, so it is never offered and no device-refusal is spoken.
 */

const openWebsite: CirceClientActionExecutor = async (args) => {
  const value = circeClientActionTextArg(args, "website");
  if (value === undefined) {
    return { status: "failed", speech: "I didn't catch which site to open." };
  }
  const safe = circeWebsiteUrl(value, value);
  if (safe === null) return { status: "failed", speech: `I couldn't open ${value}.` };
  try {
    await Linking.openURL(safe);
    return { status: "ok", speech: `Opening ${value}.` };
  } catch {
    return { status: "failed", speech: `I couldn't open ${value}.` };
  }
};

const clipboard: CirceClientActionExecutor = async (args) => {
  const action = circeClientActionTextArg(args, "action");
  if (action === "copy") {
    const text = circeClientActionTextArg(args, "text");
    if (text === undefined) return { status: "failed", speech: "I don't have anything to copy." };
    await Clipboard.setStringAsync(text);
    return { status: "ok", speech: "Copied." };
  }
  if (action === "paste") {
    const text = await Clipboard.getStringAsync();
    return {
      status: "ok",
      speech: text.trim().length === 0 ? "The clipboard is empty." : `Pasted: ${text.slice(0, 80)}`,
    };
  }
  return { status: "failed", speech: "I didn't catch the clipboard command." };
};

export const mobileClientActionExecutors: CirceClientActionExecutors = {
  "open-website": openWebsite,
  clipboard,
};

/**
 * Tools this phone can run. App launching and media control need a live
 * catalog the client does not build yet, so they stay unadvertised instead of
 * being refused at run time. Task-lifecycle notifications are dispatched by the
 * node from orchestration events, not requested by the model.
 */
export function mobileClientActionCapabilities(): CirceClientActionCapabilities {
  const tools: ReadonlyArray<CirceClientToolName> = ["open-website", "clipboard"];
  return { tools, candidates: {} };
}
