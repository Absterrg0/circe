/**
 * Which provider models can see a screenshot. Desktop computer use can drive a
 * canvas or GL app only when the running model accepts image input; the
 * accessibility path needs no vision. Provider model catalogs expose no
 * modality field, so this is a curated allowlist by model-id family. Unknown
 * models are treated as text-only: the vision tools refuse and steer the
 * caller to the accessibility loop or to a multimodal model.
 */

/** Substrings that identify a known vision-capable model family. */
const VISION_MODEL_MARKERS: ReadonlyArray<string> = [
  "claude", // Claude 3 and later are multimodal
  "gemini",
  "grok",
  "gpt-4o",
  "gpt-4.1",
  "gpt-5",
  "o3",
  "o4",
  "phi-4-multimodal",
  "llama-4",
  "qwen2.5-vl",
  "qwen3-vl",
  "qwen3.5-vl",
  "-vl-",
  "-vision",
];

/**
 * Substrings that identify a coding-focused family whose CLI path does not
 * forward images, even where the underlying family name suggests vision.
 */
const TEXT_ONLY_MODEL_MARKERS: ReadonlyArray<string> = ["codex"];

/** True when the model id is known to accept image input. Conservative. */
export function modelSupportsImageInput(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  if (id.length === 0) return false;
  if (TEXT_ONLY_MODEL_MARKERS.some((marker) => id.includes(marker))) return false;
  return VISION_MODEL_MARKERS.some((marker) => id.includes(marker));
}

export const CIRCE_DESKTOP_VISION_UNAVAILABLE_MESSAGE =
  "The selected model can't see the screen. Choose a multimodal desktop-use model in the command center, or use the accessibility path.";
