import type { HarnessAdapter } from "../protocol.js";

/**
 * Claude Code's noninteractive entry is --print. Its permission modes are not the
 * proven Codex sandbox contract, so managed launch and read-only replanning stay
 * blocked in selectedAdapter until real native proofs exist.
 */
export const claudeAdapter: HarnessAdapter = {
  harness: "claude",
  version: "1",
  binary: "claude",
  versionArgs: ["--version"],
  launchArgs: prompt => ["--print", "--output-format", "json", prompt],
};
