import type { HarnessAdapter } from "../protocol.js";

/** CLI arguments only. Managed admission still requires real capability evidence. */
export const codexAdapter: HarnessAdapter = {
  harness: "codex",
  version: "1",
  binary: "codex",
  versionArgs: ["--version"],
  launchArgs: prompt => ["exec", "--json", "--sandbox", "workspace-write", "--", prompt],
};
