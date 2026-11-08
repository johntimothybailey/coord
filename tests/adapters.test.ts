import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { codexAdapter } from "../src/adapters/codex.js";
import { antigravityAdapter } from "../src/adapters/antigravity.js";
import { claudeAdapter } from "../src/adapters/claude.js";
import { HARNESSES, harnessAdapter } from "../src/adapters/registry.js";

test("host launch arguments retain sandboxing and preserve a prompt as one argument", () => {
  const prompt = "--help; $(touch /tmp/never-execute)\nquoted \"prompt\"";
  assert.deepEqual(codexAdapter.launchArgs(prompt), ["exec", "--json", "--sandbox", "workspace-write", "--", prompt]);
  assert.deepEqual(antigravityAdapter.launchArgs(prompt), ["--sandbox", "--output-format", "stream-json", "--print", prompt]);
  assert.deepEqual(claudeAdapter.launchArgs(prompt), ["--print", "--output-format", "json", prompt]);
  assert.equal(antigravityAdapter.binary, "agy");
  assert.equal(claudeAdapter.binary, "claude");
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

test("the harness registry resolves every declared harness to its own adapter", () => {
  assert.deepEqual([...HARNESSES], ["codex", "antigravity", "claude"]);
  for (const harness of HARNESSES) assert.equal(harnessAdapter(harness).harness, harness);
  const binaries = HARNESSES.map(harness => harnessAdapter(harness).binary);
  assert.equal(new Set(binaries).size, binaries.length, "each harness must probe a distinct binary");
});

test("the Claude plugin uses the documented layout and a narrow mutation matcher", async () => {
  const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
  const manifest = await json("plugins/claude/.claude-plugin/plugin.json");
  assert.equal(manifest.name, "coord");
  assert.deepEqual((await json("plugins/claude/.mcp.json")).mcpServers.coord, { command: "coord", args: ["mcp"] });
  const hooks = (await json("plugins/claude/hooks/hooks.json")).hooks;
  assert.equal(hooks.SessionStart[0].hooks[0].command, "coord hook claude SessionStart");
  const pre = hooks.PreToolUse[0];
  assert.equal(pre.hooks[0].command, "coord hook claude PreToolUse");
  // A denial is only ever possible on a mutation tool, so the matcher must not fire on reads.
  assert.equal(pre.matcher, "Bash|Edit|Write|NotebookEdit");
  assert.equal(pre.hooks[0].onFailure, "block");
});
