import { createFileRoute, redirect } from "@tanstack/react-router";

// The command center became Home. Old links, the tray, and the voice hotkey
// used to open /circe; they land on Home now.
export const Route = createFileRoute("/circe")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
