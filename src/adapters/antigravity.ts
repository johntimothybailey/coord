import type { HarnessAdapter } from "../protocol.js";

/** Antigravity's supported CLI binary is agy, not antigravity. */
export const antigravityAdapter: HarnessAdapter = {
  harness: "antigravity",
  version: "1",
  binary: "agy",
  versionArgs: ["--version"],
  launchArgs: prompt => ["--sandbox", "--output-format", "stream-json", "--print", prompt],
};
