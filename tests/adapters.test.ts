import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { codexAdapter } from "../src/adapters/codex.js";
import { antigravityAdapter } from "../src/adapters/antigravity.js";

test("host launch arguments retain sandboxing and preserve a prompt as one argument", () => {
  const prompt = "--help; $(touch /tmp/never-execute)\nquoted \"prompt\"";
  assert.deepEqual(codexAdapter.launchArgs(prompt), ["exec", "--json", "--sandbox", "workspace-write", "--", prompt]);
  assert.deepEqual(antigravityAdapter.launchArgs(prompt), ["--sandbox", "--output-format", "stream-json", "--print", prompt]);
  assert.equal(antigravityAdapter.binary, "agy");
});

test("host plugin packages wire stdio and native check-in hooks", async () => {
  // Resolve repository assets from cwd; compiled tests live under dist/tests/.
  const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
  const codex = await json("plugins/codex/.codex-plugin/plugin.json");
  assert.equal(codex.hooks, "./hooks/hooks.json");
  assert.deepEqual((await json("plugins/codex/.mcp.json")).mcpServers.coord, { command: "coord", args: ["mcp"] });
  assert.deepEqual((await json("plugins/antigravity/mcp_config.json")).mcpServers.coord, { command: "coord", args: ["mcp"] });
  assert.equal((await json("plugins/codex/hooks/hooks.json")).hooks.PreToolUse[0].hooks[0].command, "coord hook codex PreToolUse");
  assert.equal((await json("plugins/antigravity/hooks.json"))["coord-checkin"].PreToolUse[0].hooks[0].command, "coord hook antigravity PreToolUse");
});
