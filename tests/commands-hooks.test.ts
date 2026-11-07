import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { commandsFixture } from "./commands.fixture.js";
import { runtimeDigest } from "../src/command-runtime.js";
import { digest } from "../convex/auth.js";
import { main } from "../src/cli.js";

test("T5 parsed stateless hook and rule sync use protected runtime refs under an empty worker HOME", async () => {
  const f = await commandsFixture(), originalCwd = process.cwd(), originalLog = console.log, originalRuntime = process.env.COORD_RUNTIME_PATH, originalSession = process.env.COORD_SESSION_ID;
  try {
    const home = join(f.directory, "empty-hook-worker"); await mkdir(home, { mode: 0o700 });
    f.runtime.policy.workerHome = home;
    const hash = runtimeDigest(f.runtime); f.runtime.capability.key.configurationDigest = hash;
    for (const check of f.runtime.capability.checks) check.configurationDigest = hash;
    await f.saveRuntime();
    await f.backend.context().db.patch(f.backend.find("machines", f.runtime.machineId)._id, { capabilityKey: f.runtime.capability.key, capabilityChecks: f.runtime.capability.checks, capabilityDigest: await digest(JSON.stringify(f.runtime.capability.key)) });
    const prepared = await f.cli(f.repo, ["resume", "task", "--prepare-only", "--runtime", f.runtimePath, "--session", "hook_runtime"]) as { path: string };
    process.env.HOME = home; process.env.COORD_RUNTIME_PATH = f.runtimePath; process.env.COORD_SESSION_ID = "hook_runtime"; process.chdir(prepared.path);
    const output: string[] = []; console.log = value => { output.push(String(value)); };
    await main(["hook", "codex", "PreToolUse"], { hookInput: Readable.from([JSON.stringify({ tool_name: "apply_patch" })]) });
    const response = JSON.parse(output.at(-1)!) as { hookSpecificOutput: { additionalContext: string; permissionDecision?: string } };
    assert.notEqual(response.hookSpecificOutput.permissionDecision, "deny");
    assert.match(response.hookSpecificOutput.additionalContext, /current-run/);
    await main(["rules", "sync"]);
    assert.match(await readFile(join(prepared.path, "AGENTS.md"), "utf8"), /COORD/);
    await assert.rejects(readFile(join(home, ".config/coord/workspaces.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(home, ".config/coord/credentials")), { code: "ENOENT" });
    assert.equal(f.calls.filter(call => call.path === "lifecycle:confirmStopped").length, 0);
  } finally {
    console.log = originalLog; process.chdir(originalCwd);
    if (originalRuntime === undefined) delete process.env.COORD_RUNTIME_PATH; else process.env.COORD_RUNTIME_PATH = originalRuntime;
    if (originalSession === undefined) delete process.env.COORD_SESSION_ID; else process.env.COORD_SESSION_ID = originalSession;
    await f.restore();
  }
});
