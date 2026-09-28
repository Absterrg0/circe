import type { CirceBotId, EnvironmentId } from "@circe/contracts";

/** Warm tints from the Circe palette; avatars never use off-brand hues. */
const BOT_TINTS = [
  "linear-gradient(140deg, #e18a62, #6d3526)",
  "linear-gradient(140deg, #ffd8bd, #b5725a)",
  "linear-gradient(140deg, #ebbb62, #835900)",
  "linear-gradient(140deg, #d7aee0, #853f8f)",
  "linear-gradient(140deg, #72c9a4, #13704f)",
  "linear-gradient(140deg, #e8946f, #a04a27)",
] as const;

function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) >>> 0;
  }
  return result;
}

/** A stable tint per bot id, so a bot keeps its color across renames. */
export function botTint(botId: string): string {
  return BOT_TINTS[hash(botId) % BOT_TINTS.length]!;
}

/** One or two letters from the bot's name: "YT desk" becomes "YD". */
export function botMonogram(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}

export interface BotRef {
  readonly environmentId: EnvironmentId;
  readonly botId: CirceBotId;
}

export function botRefKey(ref: BotRef): string {
  return `${ref.environmentId}\u0000${ref.botId}`;
}
