// Circe browser connector service worker. It keeps one native messaging
// connection to the local Circe node, attaches the debugger to exactly one
// visible tab, and answers grounded observation/action requests. Nothing is
// stored beyond the connector instance id and the user's profile label.

import {
  attach,
  click,
  detach,
  isAttached,
  navigate,
  pressKey,
  scroll,
  snapshot,
  typeText,
} from "./debugger-session.js";

const HOST_NAME = "com.circe.browser_connector";
const RECONNECT_ALARM = "circe-browser-connector-reconnect";

/** @type {chrome.runtime.Port | null} */
let port = null;
/** @type {number | null} */
let attachedTabId = null;
let connected = false;

const readSettings = async () => {
  const stored = await chrome.storage.local.get({
    circeInstanceId: null,
    circeProfileLabel: "Chrome",
  });
  let instanceId = stored.circeInstanceId;
  if (typeof instanceId !== "string" || instanceId.length === 0) {
    instanceId = crypto.randomUUID();
    await chrome.storage.local.set({ circeInstanceId: instanceId });
  }
  const profileLabel =
    typeof stored.circeProfileLabel === "string" && stored.circeProfileLabel.trim().length > 0
      ? stored.circeProfileLabel.trim()
      : "Chrome";
  return { instanceId, profileLabel };
};

const status = () => ({
  connected,
  attachedTabId,
});

const respond = (response) => {
  if (port !== null) port.postMessage(response);
};

const requireAttachedTab = () => {
  if (attachedTabId === null) throw new Error("No browser tab is attached.");
  return attachedTabId;
};

const handleRequest = async (request) => {
  const id = request.id;
  try {
    switch (request.type) {
      case "tab.list": {
        const tabs = await chrome.tabs.query({});
        respond({
          id,
          type: "tab.list.result",
          tabs: tabs
            .filter((tab) => typeof tab.id === "number")
            .slice(0, 64)
            .map((tab) => ({
              tabId: String(tab.id),
              title: tab.title ?? "",
              url: tab.url ?? "",
              active: tab.active === true,
              ...(typeof tab.windowId === "number" ? { windowId: String(tab.windowId) } : {}),
            })),
        });
        return;
      }
      case "tab.attach": {
        const tabId = Number(request.tabId);
        if (!Number.isInteger(tabId)) throw new Error("The tab id is invalid.");
        if (attachedTabId !== null && attachedTabId !== tabId) {
          await detach(attachedTabId);
        }
        if (!(await isAttached(tabId))) await attach(tabId);
        attachedTabId = tabId;
        const { profileLabel } = await readSettings();
        respond({ id, type: "tab.attach.result", tabId: String(tabId), profileLabel });
        return;
      }
      case "tab.detach": {
        if (attachedTabId !== null) {
          await detach(attachedTabId);
          attachedTabId = null;
        }
        respond({ id, type: "tab.detach.result" });
        return;
      }
      case "snapshot": {
        const snapshotValue = await snapshot(requireAttachedTab());
        respond({ id, type: "snapshot.result", snapshot: snapshotValue });
        return;
      }
      case "action": {
        const tabId = requireAttachedTab();
        const action = request.action;
        switch (action.operation) {
          case "click":
            await click(tabId, action.locator);
            break;
          case "type":
            await typeText(tabId, action.locator, action.text);
            break;
          case "press":
            await pressKey(tabId, action.key);
            break;
          case "navigate":
            await navigate(tabId, action.url);
            break;
          case "scroll":
            await scroll(tabId, action.deltaX, action.deltaY);
            break;
          default:
            throw new Error("The connector does not support that action.");
        }
        respond({ id, type: "action.result", ok: true });
        return;
      }
      default:
        respond({ id, type: "error", message: "The connector does not support that request." });
    }
  } catch (error) {
    respond({
      id,
      type: "error",
      message: error instanceof Error ? error.message : "The connector failed that request.",
    });
  }
};

const scheduleReconnect = () => {
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 0.5 });
};

const connect = async () => {
  if (port !== null) return;
  const { instanceId, profileLabel } = await readSettings();
  try {
    const nextPort = chrome.runtime.connectNative(HOST_NAME);
    port = nextPort;
    nextPort.onMessage.addListener((message) => {
      if (message?.type === "hello.result") {
        connected = message.ok === true;
        return;
      }
      if (message?.type === "error" && message.id === undefined) return;
      if (message?.type === "error" && message.id !== undefined) {
        respond(message);
        return;
      }
      void handleRequest(message);
    });
    nextPort.onDisconnect.addListener(() => {
      port = null;
      connected = false;
      scheduleReconnect();
    });
    nextPort.postMessage({
      type: "hello",
      extensionVersion: chrome.runtime.getManifest().version,
      instanceId,
      profileLabel,
    });
  } catch {
    port = null;
    connected = false;
    scheduleReconnect();
  }
};

chrome.runtime.onInstalled.addListener(() => {
  void connect();
});
chrome.runtime.onStartup.addListener(() => {
  void connect();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) void connect();
});

// Losing the attached tab is told to the node, so it never keeps acting on,
// or reporting, a tab this extension no longer controls.
const forgetAttachedTab = (tabId, reason) => {
  if (tabId !== attachedTabId) return;
  attachedTabId = null;
  if (port !== null) port.postMessage({ type: "tab.detached", tabId: String(tabId), reason });
};
chrome.debugger.onDetach.addListener((source, reason) => {
  forgetAttachedTab(source.tabId, reason === "target_closed" ? "closed" : "detached");
});
chrome.tabs.onRemoved.addListener((tabId) => {
  forgetAttachedTab(tabId, "closed");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "circe.connector.status") {
    sendResponse(status());
    return true;
  }
  if (message?.type === "circe.connector.reconnect") {
    void connect();
    sendResponse(status());
    return true;
  }
  return false;
});

void connect();
