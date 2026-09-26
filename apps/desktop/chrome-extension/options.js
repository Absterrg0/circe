const profileInput = document.getElementById("profile");
const saveButton = document.getElementById("save");
const statusLine = document.getElementById("status");

const render = (status) => {
  statusLine.textContent = status?.connected
    ? status.attachedTabId === null
      ? "Connected to Circe. No tab attached yet."
      : `Connected to Circe. Controlling tab ${status.attachedTabId}.`
    : "Not connected. Start Circe on this machine, then reload this page.";
};

const refresh = async () => {
  const status = await chrome.runtime.sendMessage({ type: "circe.connector.status" });
  render(status);
};

const load = async () => {
  const stored = await chrome.storage.local.get({ circeProfileLabel: "Chrome" });
  profileInput.value =
    typeof stored.circeProfileLabel === "string" ? stored.circeProfileLabel : "Chrome";
  await refresh();
};

saveButton.addEventListener("click", async () => {
  const label = profileInput.value.trim() || "Chrome";
  await chrome.storage.local.set({ circeProfileLabel: label });
  await chrome.runtime.sendMessage({ type: "circe.connector.reconnect" });
  await refresh();
});

void load();
