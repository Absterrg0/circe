import { CirceMemoryEntry } from "@circe/contracts";
import * as Schema from "effect/Schema";

/**
 * Project memory as workspace files, the way Cursor and Claude Code keep
 * project context: the provider reads them on demand with its ordinary file
 * tools. Memory bodies live under `.circe/memory/`, retired bodies under
 * `.circe/memory/retired/`, and the pinned map is a managed block in the
 * project's `AGENTS.md` so every provider already knows to read it.
 */
export const CIRCE_DIR = ".circe";
export const MEMORY_DIR = "memory";
export const RETIRED_DIR = "retired";
export const INDEX_FILE = "index.md";
export const CONTEXT_FILE = "CIRCE.md";
export const AGENTS_FILE = "AGENTS.md";

export const AGENTS_BEGIN = "<!-- circe:begin -->";
export const AGENTS_END = "<!-- circe:end -->";

const MEMORY_MARKER = "circe-memory";

const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(CirceMemoryEntry));
const encodeEntry = Schema.encodeSync(Schema.fromJsonString(CirceMemoryEntry));

/** One entry file: a machine-readable marker line, then the human body. */
export function renderMemoryFile(entry: CirceMemoryEntry): string {
  return `<!-- ${MEMORY_MARKER} ${encodeEntry(entry)} -->\n\n${entry.body}\n`;
}

export function parseMemoryFile(text: string): CirceMemoryEntry | null {
  const prefix = `<!-- ${MEMORY_MARKER} `;
  if (!text.startsWith(prefix)) return null;
  // The marker is one line; the terminator is always the last " -->" on it, so
  // a value containing the delimiter cannot truncate the JSON.
  const newline = text.indexOf("\n");
  const marker = newline === -1 ? text : text.slice(0, newline);
  const end = marker.lastIndexOf(" -->");
  if (end < prefix.length) return null;
  try {
    return decodeEntry(marker.slice(prefix.length, end));
  } catch {
    return null;
  }
}

const occurrences = (haystack: string, needle: string): number[] => {
  const indices: number[] = [];
  let from = haystack.indexOf(needle);
  while (from !== -1) {
    indices.push(from);
    from = haystack.indexOf(needle, from + needle.length);
  }
  return indices;
};

/**
 * Replace a project's managed Circe block, leaving user content untouched. A
 * block is only treated as managed when it has exactly one well-ordered pair of
 * markers; anything else (an orphan marker, or a marker quoted inside user
 * text) is left alone and the block is appended, so user content is never
 * deleted by a malformed or injected marker.
 */
export function upsertAgentsBlock(existing: string | null, block: string): string {
  const managed = `${AGENTS_BEGIN}\n${block}\n${AGENTS_END}`;
  if (existing === null || existing.trim().length === 0) return `${managed}\n`;
  const starts = occurrences(existing, AGENTS_BEGIN);
  const ends = occurrences(existing, AGENTS_END);
  const start = starts[0];
  const end = ends[0];
  if (starts.length === 1 && ends.length === 1 && start !== undefined && end !== undefined) {
    return `${existing.slice(0, start)}${managed}${existing.slice(end + AGENTS_END.length)}`;
  }
  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${managed}\n`;
}
