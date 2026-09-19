import { CirceBrowserUseInput, CirceBrowserUseResult } from "./circeBrowserUse.ts";

/**
 * A desktop computer-use mission. It has the same bounded shape as a browser
 * mission: a goal, optional planned text, a step cap, a once-per-session
 * confirmation, and a typed result. The surface differs (the OS desktop
 * instead of a browser tab) but the origin client treats them the same way.
 */
export const CirceComputerUseInput = CirceBrowserUseInput;
export type CirceComputerUseInput = typeof CirceComputerUseInput.Type;

export const CirceComputerUseResult = CirceBrowserUseResult;
export type CirceComputerUseResult = typeof CirceComputerUseResult.Type;
