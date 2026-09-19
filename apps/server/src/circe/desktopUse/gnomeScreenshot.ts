import type { DesktopCommand } from "./platforms.ts";

/**
 * GNOME Wayland screenshots through the desktop portal. Mutter does not expose
 * wlr-screencopy (grim) and restricts `org.gnome.Shell.Screenshot` to the shell
 * itself, so on a stock GNOME session the portal is the only unattended path.
 * The portal has no CLI, so a short embedded Python client opens the request,
 * waits for the Response signal, and moves the file the portal wrote to the
 * caller's path. The script removes the portal-owned copy it just produced.
 */

export const PORTAL_SCREENSHOT_SCRIPT = `
import os, shutil, sys, time
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

out_path = sys.argv[1]
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
state = {"response": None, "uri": None}
loop = GLib.MainLoop()

def on_response(conn, sender, obj, iface, signal, params, user_data):
    response, results = params.unpack()
    state["response"] = response
    state["uri"] = results.get("uri")
    loop.quit()

bus.signal_subscribe(
    "org.freedesktop.portal.Desktop",
    "org.freedesktop.portal.Request",
    "Response",
    None, None, Gio.DBusSignalFlags.NONE,
    on_response, None,
)

args = GLib.Variant("(sa{sv})", ("", {"interactive": GLib.Variant("b", False)}))
reply = bus.call_sync(
    "org.freedesktop.portal.Desktop",
    "/org/freedesktop/portal/desktop",
    "org.freedesktop.portal.Screenshot",
    "Screenshot",
    args, None, Gio.DBusCallFlags.NONE, 5000, None,
)
GLib.timeout_add_seconds(8, lambda: (loop.quit(), False)[-1])
loop.run()
if state["response"] != 0 or not state["uri"]:
    print("portal screenshot failed", file=sys.stderr)
    sys.exit(2)
source = GLib.filename_from_uri(state["uri"])[0]
shutil.copyfile(source, out_path)
try:
    # The portal always writes into Pictures; this process created it and the
    # caller owns the copy, so leave the user's directory as it was.
    os.remove(source)
except OSError:
    pass
`.trim();

export const buildPortalScreenshotCommand = (outPath: string): DesktopCommand => ({
  command: "python3",
  args: ["-c", PORTAL_SCREENSHOT_SCRIPT, outPath],
});
