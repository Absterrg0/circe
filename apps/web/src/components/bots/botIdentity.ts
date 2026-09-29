import type { CirceBotId, EnvironmentId } from "@circe/contracts";

/** Warm tints from the Circe palette; avatars never use off-brand hues. */
const BOT_TINTS = [
  "linear-gradient(140deg, #f26b3a, #a8401a)",
  "linear-gradient(140deg, #c9a79b, #8c6a60)",
  "linear-gradient(140deg, #d89545, #9b6533)",
  "linear-gradient(140deg, #9b6658, #4a2d2a)",
  "linear-gradient(140deg, #667c96, #3e4f63)",
  "linear-gradient(140deg, #ffa47a, #cc4a14)",
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
