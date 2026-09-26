# Browser connector

The browser connector lets Circe control one visible tab in your own signed-in Chrome profile. It is
how "open YouTube and search for that phrase in my browser" works on a Full or Controller node
without opening a separate debugging browser or moving your session into a preview window.

## Setting it up

1. Install and start the Circe desktop app on the machine whose browser you want to control.
2. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select the
   `chrome-extension` folder shipped with the app (in development, `apps/desktop/chrome-extension`).
3. Pin the **Circe Browser Connector** extension and open its options page. Give the profile a label
   such as "Work Chrome" so you can pick it when more than one profile is connected.

The desktop app registers the native messaging host on startup. If Chrome was open before the app
was installed, restart Chrome once after installing the extension.

## Using it

Ask in plain language, from any paired device:

- "Open YouTube on my desktop and search for tanmay bhat."
- "In my browser, find the pricing page and open the contact form."

Circe attaches to one tab, reads its structure, and acts on named controls. It shows what it is
doing; closing the tab or detaching the debugger stops the mission.

## What it will not do

- It never opens a public debugging port. The extension talks to the node over a token-protected
  local socket that only your user account can read.
- It controls one attached tab. It does not read other tabs, windows, or profiles.
- It does not use your browser when the extension is not connected. Without it, Circe falls back to
  desktop accessibility control of the browser window, which is less reliable on pages that expose
  poor accessibility data.
- It cannot control `chrome://` pages, the Chrome Web Store, or other protected pages.

## Multiple profiles and machines

Each Chrome profile runs its own connector with its own label. A mission binds to the node and
profile you name. If a profile disconnects, Circe reports the disconnection instead of silently
using another browser.

## Troubleshooting

- "The browser connector isn't connected": the extension is not installed, Chrome is closed, or the
  native host registration is missing. Reload the extension and restart Chrome.
- Actions fail with "the element is no longer valid": the page changed between observation and the
  action. Ask again; Circe takes a fresh snapshot.
- The wrong tab moves: attach the tab you want first, or name the site in your request so Circe
  navigates the attached tab to it.
