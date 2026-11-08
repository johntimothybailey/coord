import { CoordError, type Harness, type HarnessAdapter } from "../protocol.js";
import { antigravityAdapter } from "./antigravity.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";

export const HARNESSES: readonly Harness[] = ["codex", "antigravity", "claude"];

/** One lookup so a new harness cannot silently fall through to another adapter. */
export function harnessAdapter(harness: Harness): HarnessAdapter {
  switch (harness) {
    case "codex": return codexAdapter;
    case "antigravity": return antigravityAdapter;
    case "claude": return claudeAdapter;
    default: throw new CoordError("INVALID_INPUT", "Unknown harness");
  }
}
