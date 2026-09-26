import { runBrowserConnectorNativeHost } from "./nativeHost.ts";

// Chrome launches this entry point as its native messaging host. stdout is the
// native channel, so nothing else may write to it.
void runBrowserConnectorNativeHost().catch(() => {
  process.exitCode = 0;
});
