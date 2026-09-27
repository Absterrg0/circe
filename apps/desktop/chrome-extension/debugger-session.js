// Chrome debugger session for one attached tab. Every observation and action
// goes through the debugger protocol on an explicit tab id; nothing here reads
// or drives a tab the user did not attach.

const PROTOCOL_VERSION = "1.3";
const MAX_ELEMENTS = 120;
const MAX_VISIBLE_TEXT = 8000;

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "[role]",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[tabindex]",
].join(",");

export async function attach(tabId) {
  await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  for (const domain of ["Page.enable", "DOM.enable", "Accessibility.enable", "Runtime.enable"]) {
    await chrome.debugger.sendCommand({ tabId }, domain);
  }
}

export async function detach(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Detaching an already-detached tab is not actionable.
  }
}

export async function isAttached(tabId) {
  const targets = await chrome.debugger.getTargets();
  return targets.some((target) => target.tabId === tabId && target.attached);
}

const send = (tabId, method, params) =>
  chrome.debugger.sendCommand({ tabId }, method, params ?? {});

const editableFromNode = (node) => {
  const name = (node.nodeName ?? "").toUpperCase();
  if (name === "INPUT" || name === "TEXTAREA" || name === "SELECT") return true;
  const attributes = node.attributes ?? [];
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    if (attributes[index] === "contenteditable") {
      const value = attributes[index + 1];
      return value === "" || value === "true";
    }
  }
  return false;
};

export async function snapshot(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const { root } = await send(tabId, "DOM.getDocument", { depth: -1, pierce: true });
  const { nodeIds } = await send(tabId, "DOM.querySelectorAll", {
    nodeId: root.nodeId,
    selector: INTERACTIVE_SELECTOR,
  });
  const limited = nodeIds.slice(0, MAX_ELEMENTS);
  const { nodes: axNodes } = await send(tabId, "Accessibility.getFullAXTree");
  const axByBackendId = new Map();
  for (const node of axNodes) {
    const backendId = node.backendDOMNodeId;
    if (typeof backendId !== "number" || node.ignored === true) continue;
    const role = node.role?.value;
    if (role === "generic" || role === "none" || role === "InlineTextBox") continue;
    // Value and state parity with the desktop observers: a field's current
    // text and a control's checked/selected state are what make a typed value
    // or a toggled control visible to the step selector and the goal check.
    const states = [];
    if (node.checked?.value === "true" || node.checked?.value === "mixed") states.push("checked");
    if (node.selected?.value === true) states.push("selected");
    if (node.focused?.value === true) states.push("focused");
    if (node.expanded?.value === true) states.push("expanded");
    axByBackendId.set(backendId, {
      role: typeof role === "string" ? role : null,
      name: typeof node.name?.value === "string" ? node.name.value : "",
      value: typeof node.value?.value === "string" ? node.value.value.slice(0, 400) : "",
      states,
    });
  }

  const elements = [];
  const seen = new Set();
  for (const nodeId of limited) {
    let described;
    try {
      described = await send(tabId, "DOM.describeNode", { nodeId });
    } catch {
      continue;
    }
    const backendNodeId = described?.node?.backendNodeId;
    if (typeof backendNodeId !== "number" || seen.has(backendNodeId)) continue;
    const ax = axByBackendId.get(backendNodeId);
    if (ax === undefined) continue;
    seen.add(backendNodeId);
    let bounds;
    try {
      const { model } = await send(tabId, "DOM.getBoxModel", { nodeId });
      const quad = model?.border;
      if (Array.isArray(quad) && quad.length === 8) {
        const xs = [quad[0], quad[2], quad[4], quad[6]];
        const ys = [quad[1], quad[3], quad[5], quad[7]];
        bounds = {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        };
      }
    } catch {
      // Bounds are optional; the extension resolves the node again on action.
    }
    elements.push({
      id: `ax:${backendNodeId}`,
      role: ax.role,
      name: ax.name.slice(0, 200),
      editable: editableFromNode(described.node ?? {}),
      ...(ax.value.length === 0 ? {} : { value: ax.value }),
      ...(ax.states.length === 0 ? {} : { state: ax.states.join(" ") }),
      ...(bounds === undefined ? {} : { bounds }),
    });
  }

  let visibleText = "";
  try {
    const { result } = await send(tabId, "Runtime.evaluate", {
      expression: "document.body ? document.body.innerText.slice(0, 8000) : ''",
      returnByValue: true,
    });
    if (typeof result?.value === "string") visibleText = result.value.slice(0, MAX_VISIBLE_TEXT);
  } catch {
    // A page without a body has no text; that is not an error.
  }

  return {
    tabId: String(tabId),
    title: tab.title ?? "",
    url: tab.url ?? "",
    visibleText,
    elements,
  };
}

const resolveBackendNodeId = (locator) => {
  const match = /^ax:(\d+)$/.exec(locator);
  return match === null ? null : Number(match[1]);
};

async function resolveObjectId(tabId, locator) {
  const backendNodeId = resolveBackendNodeId(locator);
  if (backendNodeId === null) {
    throw new Error("The element handle is no longer valid; take a fresh snapshot.");
  }
  const { object } = await send(tabId, "DOM.resolveNode", { backendNodeId });
  if (object?.objectId === undefined) {
    throw new Error("The element is no longer on the page.");
  }
  return object.objectId;
}

async function measureCenter(tabId, locator) {
  const objectId = await resolveObjectId(tabId, locator);
  const { result } = await send(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration:
      "function(){ this.scrollIntoView({block:'center', inline:'center'}); const r = this.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }",
    returnByValue: true,
  });
  const center = result?.value;
  if (center === undefined || !Number.isFinite(center.x) || !Number.isFinite(center.y)) {
    throw new Error("The element has no visible position.");
  }
  return center;
}

export async function click(tabId, locator) {
  const center = await measureCenter(tabId, locator);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send(tabId, "Input.dispatchMouseEvent", {
      type,
      x: center.x,
      y: center.y,
      button: "left",
      clickCount: 1,
    });
  }
}

export async function typeText(tabId, locator, text) {
  const objectId = await resolveObjectId(tabId, locator);
  await send(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: "function(){ this.focus(); }",
  });
  await send(tabId, "Input.insertText", { text });
}

const KEY_CODES = {
  Enter: { code: "Enter", keyCode: 13 },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
};

export async function pressKey(tabId, key) {
  const entry = KEY_CODES[key] ?? { code: key, keyCode: 0 };
  for (const type of ["rawKeyDown", "keyUp"]) {
    await send(tabId, "Input.dispatchKeyEvent", {
      type,
      key,
      code: entry.code,
      windowsVirtualKeyCode: entry.keyCode,
      nativeVirtualKeyCode: entry.keyCode,
    });
  }
}

export async function navigate(tabId, url) {
  await send(tabId, "Page.navigate", { url });
}

export async function scroll(tabId, deltaX, deltaY) {
  const { result } = await send(tabId, "Runtime.evaluate", {
    expression: "({ x: window.innerWidth / 2, y: window.innerHeight / 2 })",
    returnByValue: true,
  });
  const center = result?.value ?? { x: 200, y: 200 };
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: center.x,
    y: center.y,
    deltaX: deltaX ?? 0,
    deltaY: deltaY ?? 0,
  });
}
