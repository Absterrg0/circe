# Desktop use

Desktop use lets Circe open apps and websites, click, type, press keys, and scroll in your own
signed-in apps and browser. Each node controls the desktop of the machine it runs on.

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

Circe uses the app's window that is already open unless you ask for a new one. It types a whole
entry at once, such as `12*7` for "twelve times seven", and it reports done only when the screen
shows the result. If the app shows something else, Circe tells you what it shows.

The agent cursor marks input in the target window. When another window covers that target,
background actions can continue, but their cursor stays hidden instead of appearing over the
foreground app.

On native Wayland, arbitrary background keys may be unavailable even when accessible controls
work. Circe uses native control actions where possible and reports a refusal when CUA cannot
deliver the requested action in the background. Covered windows can still expose native controls,
but Circe does not use screenshots containing the covering window's pixels to choose actions.

One thing uses the computer at a time. If it is busy, Circe says what it is doing; stop that first.

## Letting a coding agent use it

A coding agent on a node with desktop support can ask for the computer, for example to check a page
it just changed. The request reaches you the same way: Circe says which agent wants the computer and
for what, and you approve or decline it by voice or on the Computer card. Once approved, that agent
alone can drive the computer until it hands it back, its run ends, or you say stop. If the agent's
run ends before you answer, the request goes away on its own.

Ask in chat the way you would ask Circe ("calculate 12 times 7 in the calculator"). The agent hands
the whole goal to Circe, which carries it out and checks the result the same way.

If the app exposes only the text Circe entered, such as a search box without readable results,
Circe reports that it could not verify completion. The agent must report that limitation. A
finished goal cannot be repeated through the step tools or request approval again in the same
turn. A new request from you starts a new turn and can try again.

## Controlling a remote node

A node controls the desktop of the machine it runs on. When you talk to Circe from a controller
device, the request runs on the execution node and desktop use acts on that node, not on the
controller. There is no cloud VM and no moving work to a different machine.

Desktop use requires Full or Controller running in a graphical session. Headless does not provide
desktop capture or control, even if graphical tools happen to be installed. Controller can control
its local desktop through authenticated clients, but runs coding agents on remote execution nodes.

## What each platform needs

Linux: run Circe in an X11 or Wayland graphical session with the AT-SPI accessibility bus available.
Circe enables native Wayland discovery automatically. GNOME Wayland also needs the CUA WinRects
Shell helper enabled so Circe can identify native windows.

macOS: grant Accessibility and Screen Recording to Circe when macOS asks. You can change these
permissions in System Settings under Privacy & Security.

Windows: run Circe in your signed-in desktop session. Circe reads controls through UI Automation.
Windows can refuse input to elevated applications and secure desktops.

## Apps that draw their own controls

Circe first reads the controls an app exposes through accessibility. When the perception component
is available, it can also read text and controls from the screen in apps that draw their own
interface. Circe downloads that component once on first use and updates it when needed. Reading
the screen makes these steps slower, often several seconds for each look.

Screen reading currently ships for macOS on Apple silicon, Windows x64, and Linux x64. Other
supported architectures use accessible controls. If screen reading is unavailable or its download fails, apps with
accessible controls still work. The Computer card shows the limitation. Circe stops when it cannot
find a usable control instead of guessing where to click.

## Troubleshooting

- "Desktop use is unavailable": the Circe desktop app is not running on the node, or the node has no
  graphical session. Circe says the reason when you ask it to use the computer.
- A Linux app is missing: on GNOME Wayland, check that the CUA WinRects Shell helper is enabled.
- An app's controls cannot be read: check the Computer card for a screen-reading limitation and
  check your network connection if the component has not downloaded yet.
- A screen-based click is refused because the target is covered: bring the target window into view
  and ask again. Circe refuses clicks that would land on a different application.
- macOS cannot control or capture an app: check Circe's Accessibility and Screen Recording
  permissions in System Settings.
