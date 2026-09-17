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
import * as Notifications from "expo-notifications";

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

const notifications: CirceClientActionExecutor = async (args) => {
  const title = circeClientActionTextArg(args, "title") ?? "Circe";
  const body = circeClientActionTextArg(args, "body") ?? "";
  const current = await Notifications.getPermissionsAsync();
  let granted = current.granted;
  if (!granted) {
    const requested = await Notifications.requestPermissionsAsync();
    granted = requested.granted;
  }
  if (!granted) return { status: "failed", speech: "Notifications are blocked for this app." };
  await Notifications.scheduleNotificationAsync({
    content: { title, ...(body.length === 0 ? {} : { body }) },
    trigger: null,
  });
  return { status: "ok", speech: "Notified." };
};

export const mobileClientActionExecutors: CirceClientActionExecutors = {
  "open-website": openWebsite,
  clipboard,
  notifications,
};

/**
 * Tools this phone can run. App launching and media control need a live
 * catalog the client does not build yet, so they stay unadvertised instead of
 * being refused at run time.
 */
export function mobileClientActionCapabilities(): CirceClientActionCapabilities {
  const tools: ReadonlyArray<CirceClientToolName> = ["open-website", "clipboard", "notifications"];
  return { tools, candidates: {} };
}
