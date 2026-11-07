import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { commandsFixture } from "./commands.fixture.js";
import { main } from "../src/cli.js";

test("T1/T20 parsed plain MCP stays advisory despite a legacy session and model-supplied qualified host", async t => {
  const f = await commandsFixture(), input = new PassThrough(), output = new PassThrough();
  const cwd = process.cwd(), previousRuntime = process.env.COORD_RUNTIME_PATH, previousSession = process.env.COORD_SESSION_ID;
  let sequence = 0, buffer = "";
  const waiting = new Map<number, { resolve(value: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) { const index = buffer.indexOf("\n"); if (index < 0) break; const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue; const response = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown }; if (response.id === undefined) continue; const request = waiting.get(response.id); if (request) { clearTimeout(request.timer); waiting.delete(response.id); request.resolve(response.result ?? response.error); } }
  });
  const request = (method: string, params: unknown = {}) => new Promise<unknown>((resolveResult, reject) => { const id = ++sequence; waiting.set(id, { resolve: resolveResult, timer: setTimeout(() => reject(new Error("Bounded plain MCP fixture request timed out")), 10_000) }); input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const tool = (name: string, args: Record<string, unknown>) => request("tools/call", { name, arguments: args }) as Promise<{ isError?: boolean; content: { text: string }[] }>;
  try {
    const prepared = await f.cli(f.repo, ["resume", "task", "--prepare-only", "--runtime", f.runtimePath, "--session", "legacy_advisory"]) as { path: string };
    const receipt = JSON.parse(await readFile(join(prepared.path, ".coord-local/sessions/legacy_advisory/admission.json"), "utf8")) as { input: Record<string, unknown> };
    delete process.env.COORD_RUNTIME_PATH; process.env.COORD_SESSION_ID = "legacy_advisory"; process.chdir(prepared.path);
    f.calls.length = 0; t.mock.timers.enable({ apis: ["setInterval"] });
    await main(["mcp", "--session", "legacy_advisory"], { mcpStreams: { stdin: input, stdout: output } });
    await request("initialize", { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "plain-advisory-regression", version: "1" } });
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const registration = await tool("coord_register_manual", receipt.input);
    assert.equal(registration.isError, true);
    assert.match(JSON.stringify(registration), /BLOCKED_ENV/);
    assert.match(JSON.stringify(registration), /coord resume|protected runtime/i);
    assert.equal((await tool("coord_progress", { requestId: "legacy_progress_denied", expectedRevision: 0, progress: "No plain MCP execution" })).isError, true);
    t.mock.timers.tick(20_000); await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(!(await tool("coord_status", {})).isError);
    assert.ok(!(await tool("coord_propose_goal", { requestId: "advisory_draft", goalId: "advisory_goal", expectedRevision: 0, content: "Advisory draft only", taskLimit: 1, runTimeoutMs: 60_000 })).isError);
    assert.equal(f.backend.find("goals", "advisory_goal").state, "draft");
    assert.equal(f.calls.filter(call => ["tasks:registerManual", "tasks:claim", "tasks:claimReplan", "tasks:renew", "tasks:progress"].includes(call.path)).length, 0);
    assert.equal(f.backend.find("tasks", "task").epoch, 1);
  } finally {
    input.end(); await new Promise(resolve => setTimeout(resolve, 20)); output.end(); t.mock.timers.reset();
    for (const pending of waiting.values()) clearTimeout(pending.timer);
    process.chdir(cwd); if (previousRuntime === undefined) delete process.env.COORD_RUNTIME_PATH; else process.env.COORD_RUNTIME_PATH = previousRuntime;
    if (previousSession === undefined) delete process.env.COORD_SESSION_ID; else process.env.COORD_SESSION_ID = previousSession;
    await f.restore();
  }
});
