import { createEnvironmentRpcCommand } from "@circe/client/state/runtime";
import { WS_METHODS, type CircePushRegistrationInput } from "@circe/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const circePushEnvironment = {
  register: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "mobile:circe:register-push-token",
    tag: WS_METHODS.circeRegisterPushToken,
  }),
};

export type { CircePushRegistrationInput };
