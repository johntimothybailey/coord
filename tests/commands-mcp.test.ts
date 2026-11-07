import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { commandsFixture } from "./commands.fixture.js";
import { simulatedLinux } from "./commands-sandbox.fixture.js";
import { runtimeDigest } from "../src/command-runtime.js";
import { digest } from "../convex/auth.js";
import { main } from "../src/cli.js";

// Real stdio JSON wire + actual parsed CLI; backend, GitHub and native sandbox are explicit rehearsal transports.
test("T5/T15 parsed runtime MCP under dedicated HOME completes checkpoint/review/finalize without copied credentials", async t => {
  const sandbox = simulatedLinux(t), f = await commandsFixture();
  let input = new PassThrough(), output = new PassThrough();
  const initialHome = process.env.HOME, initialCwd = process.cwd();
  let sequence = 0, buffer = "";
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const consume = (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) { const index = buffer.indexOf("\n"); if (index < 0) break; const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue; const response = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown }; if (response.id === undefined) continue; const request = pending.get(response.id); if (!request) continue; clearTimeout(request.timer); pending.delete(response.id); response.error ? request.reject(new Error("MCP wire request rejected")) : request.resolve(response.result); }
  };
  output.on("data", consume);
  const request = (method: string, params: unknown = {}) => new Promise<unknown>((resolveResult, reject) => { const id = ++sequence; pending.set(id, { resolve: resolveResult, reject, timer: setTimeout(() => { pending.delete(id); reject(new Error(`Bounded fixture MCP request did not complete: ${method}`)); }, 60_000) }); input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const tool = (name: string, args: Record<string, unknown>) => request("tools/call", { name, arguments: args }) as Promise<{ isError?: boolean; content: { text: string }[] }>;
  try {
    const workerHome = join(f.directory, "dedicated-worker-home"); await mkdir(workerHome, { mode: 0o700 });
    f.runtime.policy.workerHome = workerHome;
    const changed = runtimeDigest(f.runtime); f.runtime.capability.key.configurationDigest = changed;
    for (const check of f.runtime.capability.checks) check.configurationDigest = changed;
    await f.saveRuntime();
    await f.backend.context().db.patch(f.backend.find("machines", f.runtime.machineId)._id, { capabilityKey: f.runtime.capability.key, capabilityChecks: f.runtime.capability.checks, capabilityDigest: await digest(JSON.stringify(f.runtime.capability.key)) });
    const prepared = await f.cli(f.repo, ["resume", "task", "--prepare-only", "--runtime", f.runtimePath, "--session", "mcp_bound"]) as { path: string };
    await writeFile(join(prepared.path, "store.js"), (await readFile(join(prepared.path, "store.js"), "utf8")) + "\n// Runtime MCP command rehearsal\n");
    process.env.HOME = workerHome; process.chdir(prepared.path);
    await assert.rejects(readFile(join(workerHome, ".config/coord/workspaces.json")), { code: "ENOENT" });
    await main(["mcp", "--runtime", f.runtimePath, "--session", "mcp_bound"], { mcpStreams: { stdin: input, stdout: output } });
    await request("initialize", { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "parsed-runtime-rehearsal", version: "1" } });
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = await request("tools/list") as { tools: { name: string }[] };
    for (const name of ["coord_checkpoint", "coord_review", "coord_finalize", "coord_finish_replan"]) assert.ok(tools.tools.some(tool => tool.name === name));
    const spoof = await tool("coord_checkpoint", { checkpointId: "spoof", runtimePath: f.runtimePath, approved: true }); assert.equal(spoof.isError, true);
    assert.equal(f.calls.filter(call => call.path === "checkpoints:prepare").length, 0);
    assert.ok(!(await tool("coord_progress", { requestId: "mcp_progress", expectedRevision: 0, progress: JSON.stringify({ completed: ["Changed actual taskboard store"], remaining: ["Publish verified artifact"] }) })).isError);
    const checkpoint = await tool("coord_checkpoint", { checkpointId: "mcp_checkpoint" }); assert.ok(!checkpoint.isError, JSON.stringify(checkpoint));
    assert.equal(f.backend.find("checkpoints", "mcp_checkpoint").state, "ready");
    const review = await tool("coord_review", { checkpointId: "mcp_checkpoint", publicationId: "mcp_publication" }); assert.ok(!review.isError, JSON.stringify(review));
    assert.equal(f.backend.find("publications", "mcp_publication").state, "accepted");
    const previousRuntime = process.env.COORD_RUNTIME_PATH, previousSession = process.env.COORD_SESSION_ID, previousLog = console.log, hookOutput: string[] = [];
    try {
      process.env.COORD_RUNTIME_PATH = f.runtimePath; process.env.COORD_SESSION_ID = "mcp_bound"; console.log = value => { hookOutput.push(String(value)); };
      await main(["hook", "codex", "PreToolUse"], { hookInput: Readable.from([JSON.stringify({ tool_name: "apply_patch" })]) });
      const hook = JSON.parse(hookOutput.at(-1)!) as { hookSpecificOutput: { permissionDecision: string } };
      assert.equal(hook.hookSpecificOutput.permissionDecision, "deny");
    } finally {
      console.log = previousLog;
      if (previousRuntime === undefined) delete process.env.COORD_RUNTIME_PATH; else process.env.COORD_RUNTIME_PATH = previousRuntime;
      if (previousSession === undefined) delete process.env.COORD_SESSION_ID; else process.env.COORD_SESSION_ID = previousSession;
    }
    input.end(); await new Promise(resolve => setTimeout(resolve, 20)); output.end();
    input = new PassThrough(); output = new PassThrough(); buffer = ""; output.on("data", consume);
    await main(["mcp", "--runtime", f.runtimePath, "--session", "mcp_bound"], { mcpStreams: { stdin: input, stdout: output } });
    await request("initialize", { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "cleanup-runtime-restart", version: "1" } });
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const before = f.calls.filter(call => call.path === "tasks:progress").length;
    const closed = await tool("coord_progress", { requestId: "after_result_denied", expectedRevision: 1, progress: "Must not mutate after accepted result" });
    assert.equal(closed.isError, true);
    assert.equal(f.calls.filter(call => call.path === "tasks:progress").length, before);
    const finalized = await tool("coord_finalize", { outcome: "succeeded" }); assert.ok(!finalized.isError, JSON.stringify(finalized));
    assert.equal(f.backend.find("tasks", "task").ownerRunId, undefined);
    assert.equal(f.calls.filter(call => call.path === "lifecycle:confirmStopped").length, 0);
    assert.ok(!JSON.stringify({ checkpoint, review, finalized }).includes('"token"'));
    await assert.rejects(readFile(join(workerHome, ".config/coord/credentials")), { code: "ENOENT" });
  } finally {
    input.end(); await new Promise(resolve => setTimeout(resolve, 20)); output.end();
    for (const value of pending.values()) clearTimeout(value.timer);
    if (initialHome === undefined) delete process.env.HOME; else process.env.HOME = initialHome;
    process.chdir(initialCwd); await f.restore(); sandbox.restore();
  }
});
