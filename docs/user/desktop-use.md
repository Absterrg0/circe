# Desktop use

Desktop use lets Circe see and control the desktop of the machine a node runs on: open apps and
websites, click, type, press keys, and scroll in your own signed-in apps and browser. Because a node only ever controls its own display, this works for a real device in your mesh
rather than a cloud virtual machine.

## Asking Circe

Tell Circe what to do on the computer: "open the browser", "open the calculator and add 12 and 30",
"open YouTube and search for lo-fi". Circe repeats the goal and asks before it touches anything:

> Use this computer for "open the browser"? Say yes to start.

Say yes to start it, or no to drop it. If you correct yourself before answering ("actually, open the
settings"), Circe asks again for the corrected goal; your earlier yes never carries over. Say "stop"
at any time to stop it. Circe tells you when it finishes, fails, or stops partway. A step that may or
may not have landed is reported as uncertain rather than done, so check the screen before asking
again.

A spoken yes counts only on the device Circe asked. While one request waits, another device can't
swap in a different one: answer or cancel the waiting request first, by voice where it was asked or
on the Computer card from any device.

Every waiting request also shows on the node's Computer card, on desktop and on your phone's Circe
screen, with Approve and Deny. Use those to answer from any device, or when you missed the spoken
question. While something runs, the same card has Stop.

One thing uses the computer at a time. If it is busy, Circe says what it is doing; stop that first.

## Letting a coding agent use it

A coding agent on a node with desktop support can ask for the computer, for example to check a page
it just changed. The request reaches you the same way: Circe says which agent wants the computer and
for what, and you approve or decline it by voice or on the Computer card. Once approved, that agent
alone can drive the computer until it hands it back, its run ends, or you say stop. If the agent's
run ends before you answer, the request goes away on its own.

## Controlling a remote node

A node controls the desktop of the machine it runs on. When you talk to Circe from a controller
device, the request runs on the execution node and desktop use acts on that node, not on the
controller. There is no cloud VM and no moving work to a different machine.

Desktop use requires Full or Controller running in a graphical session. Headless does not provide
desktop capture or control, even if graphical tools happen to be installed. Controller can control
its local desktop through authenticated clients, but runs coding agents on remote execution nodes.

## What each platform needs

Linux, X11: install `xrandr`, `xdotool`, and a capture helper (`imagemagick`, `scrot`, or
`ffmpeg`). Install `wmctrl` for window discovery and focus. On Debian/Ubuntu, `xrandr` comes
with `x11-xserver-utils`. Start the node within your graphical session.

Linux, Wayland: wlroots compositors need `wlr-randr` and `grim`; GNOME needs `gjs` and
`gnome-screenshot`. Other compositors currently report unavailable when their display geometry
cannot be queried. `wtype` provides keyboard input on compositors with the virtual-keyboard
protocol. Pointer input needs a running `ydotoold` daemon with `/dev/uinput` access and a socket
accessible to the node. `ydotool` is also a keyboard fallback, limited to ASCII text and US-layout
key positions. Wayland window discovery and focus are currently unsupported.

macOS: capture and input use system tools. Grant Screen Recording and Accessibility to the app
or terminal hosting the node when macOS requests them. Window discovery and shortcuts can also
request Automation access to System Events. Restart the node after changing permissions. Circe
reads app controls through System Events; autonomous native control on macOS is still validated
per app.

Windows: capture and input use built-in PowerShell. Run the node in the signed-in graphical
session. Circe reads app controls through UI Automation. Windows can refuse input to elevated
applications and secure desktops; desktop use does not bypass those restrictions.

## Action limits

Input is serialized across connected agents and controllers. Drags release their button on
completion or cancellation. If release fails, further input is blocked until cleanup succeeds.
Requests can still partially act before an error, so take a new screenshot before retrying.

Coordinates refer to the returned screenshot, including on scaled monitors. Targets outside the
selected display are refused. Text, scrolling, drag duration and pending requests are bounded.

## Troubleshooting

- "Desktop use is unavailable": the Circe desktop app is not running on the node, or the node has no
  graphical session. Circe says the reason when you ask it to use the computer.
- Wayland capture is unavailable: check the compositor-specific helpers above. Circe does not use
  XWayland screenshots as a fallback for native Wayland windows.
