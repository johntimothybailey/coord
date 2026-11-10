#!/usr/bin/env node
import { runDoctor } from "./doctor.js";
import { CLIENT_VERSION, CoordError } from "./protocol.js";
import { connectWorkspace } from "./client.js";
import { pathToFileURL } from "node:url";
import { runStdioMcp } from "./mcp.js";
import { backendFailure, runCoordHook } from "./hooks.js";
import { loadSession } from "./session.js";
import { exportProject, syncApprovedRules } from "./operations.js";
import { resolveWorkspace } from "./config.js";
import { setupCommand } from "./onboarding.js";
import { approveCommand } from "./approval.js";
import { connectRuntimeBridge, runCommand } from "./commands.js";
import type { Readable, Writable } from "node:stream";

export async function main(argv = process.argv.slice(2), io: { mcpStreams?: { stdin: Readable; stdout: Writable }; hookInput?: Readable } = {}): Promise<void> {
  const [command, ...args] = argv;
  if (command === "--version") { console.log(CLIENT_VERSION); return; }
  if (command === "setup") { await setupCommand(args); return; }
  if (command === "approve") { await approveCommand(args); return; }
  if (["checkpoint", "resume", "review", "daemon", "run"].includes(command ?? "")) { console.log(JSON.stringify(await runCommand(command!, args))); return; }
  if (command === "doctor") {
    if (args.some(arg => !["--json", "--no-fixtures"].includes(arg))) throw new CoordError("INVALID_INPUT", "Usage: coord doctor [--json] [--no-fixtures]");
    const report = await runDoctor({ fixtures: !args.includes("--no-fixtures") });
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else { console.log(`coord ${CLIENT_VERSION} — ${report.host.os} ${report.host.arch}`); for (const gate of report.gates) console.log(`${gate.harness} ${gate.mode}: ${gate.status}${gate.missingChecks.length ? ` (${gate.missingChecks.join(", ")})` : ""}`); }
    if (report.gates.some(g => g.status !== "PASS")) process.exitCode = 2;
    return;
  }
  if (command === "status") { console.log(JSON.stringify(await (await connectWorkspace(process.cwd())).query("projects:status"), null, 2)); return; }
  if (command === "export") {
    if (args.length !== 1) throw new CoordError("INVALID_INPUT", "Usage: coord export <new-local-file.jsonl>");
    console.log(JSON.stringify(await exportProject(await connectWorkspace(process.cwd()), args[0]!))); return;
  }
  if (command === "rules" && args[0] === "sync" && args.length === 1) {
    if (process.env.COORD_RUNTIME_PATH) {
      if (!process.env.COORD_SESSION_ID) throw new CoordError("BLOCKED_ENV", "Runtime rule synchronization requires its bound session");
      const bridge = await connectRuntimeBridge(process.cwd(), process.env.COORD_RUNTIME_PATH, process.env.COORD_SESSION_ID);
      if (bridge.cleanupOnly) throw new CoordError("LEASE_REVOKED", "Accepted-result cleanup cannot synchronize ordinary rule files");
      console.log(JSON.stringify(await syncApprovedRules(bridge.workspaceRoot, bridge.client.config.ruleTargets, bridge.run))); return;
    }
    const workspace = await resolveWorkspace(process.cwd()), client = await connectWorkspace(workspace.root);
    const run = await loadSession(workspace.root, client, process.env.COORD_SESSION_ID);
    if (!run) throw new CoordError("LEASE_REVOKED", "A current participating run is required for rule synchronization");
    console.log(JSON.stringify(await syncApprovedRules(workspace.root, workspace.config.ruleTargets, run))); return;
  }
  if (command === "mcp") {
    const root = process.cwd();
    let runtimePath = process.env.COORD_RUNTIME_PATH, sessionId = process.env.COORD_SESSION_ID;
    const seen = new Set<string>();
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index], value = args[index + 1];
      if (!flag || !value || value.startsWith("--") || !["--runtime", "--session"].includes(flag) || seen.has(flag)) throw new CoordError("INVALID_INPUT", "Usage: coord mcp [--runtime <protected-file> --session <id>]");
      seen.add(flag); if (flag === "--runtime") runtimePath = value; else sessionId = value;
    }
    if (runtimePath) {
      if (!sessionId) throw new CoordError("BLOCKED_ENV", "Trusted runtime MCP startup requires its bound participating session");
      const bridge = await connectRuntimeBridge(root, runtimePath, sessionId);
      await runStdioMcp(bridge, io.mcpStreams); return;
    }
    const client = await connectWorkspace(root);
    // Advisory intake never adopts a legacy grant or caller-selected host qualification.
    await runStdioMcp({ client }, io.mcpStreams);
    return;
  }
  if (command === "hook") {
    const harness = args[0] === "codex" || args[0] === "antigravity" || args[0] === "claude" ? args[0] : undefined;
    if (!harness || args.length > 2) throw new CoordError("INVALID_INPUT", "Usage: coord hook codex|antigravity|claude [event]");
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of io.hookInput ?? process.stdin) { const buffer = Buffer.from(chunk as Uint8Array); bytes += buffer.length; if (bytes > 64 * 1024) throw new CoordError("INVALID_INPUT", "Hook input exceeds 64 KiB"); chunks.push(buffer); }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
    const event = args[1] ?? (typeof input.hook_event_name === "string" ? input.hook_event_name : "SessionStart");
    const root = process.cwd(), runtimePath = process.env.COORD_RUNTIME_PATH, sessionId = process.env.COORD_SESSION_ID;
    if (runtimePath) {
      if (!sessionId) throw new CoordError("BLOCKED_ENV", "Runtime hook startup requires its bound session");
      const bridge = await connectRuntimeBridge(root, runtimePath, sessionId);
      console.log(JSON.stringify(await runCoordHook({ harness, event, input, run: bridge.run }))); return;
    }
    const client = await connectWorkspace(root);
    console.log(JSON.stringify(await runCoordHook({ harness, event, input, run: await loadSession(root, client, sessionId) })));
    return;
  }
  if (!command || command === "--help" || command === "help") {
    console.log("coord — private v2.5 implementation\n\n  doctor [--json] [--no-fixtures]\n  setup inspect <plan.json>\n  setup bootstrap|connect <plan.json> <absolute-encrypted-vault>\n  approve goal <goal-id> --plan <plan.json> --vault <absolute-encrypted-vault> --revision <n> --hash <sha256-hex>\n  approve policy <capture-policy.json> --plan <plan.json> --vault <absolute-encrypted-vault> --hash <sha256-hex>\n  checkpoint <id> --runtime <file> --session <id>\n  resume <task> --runtime <file> --session <id> [--checkpoint <id>] [--harness codex|antigravity] [--prepare-only]\n  review <publication> --checkpoint <id> --runtime <file> --session <id>\n  run finalize succeeded|failed|stopped --runtime <file> --session <id>\n  run reconcile <launch-id> --runtime <file> [--stop]\n  daemon --runtime <file> [--check]\n  status\n  mcp\n  hook codex|antigravity|claude [event]\n  rules sync\n  export <new-local-file.jsonl>\n  --version\n\nRuntime commands require actual qualified protected configuration. See docs/commands.md. Protected setup must run in a separate operator terminal following the maintainer's onboarding procedure."); return;
  }
  throw new CoordError("INVALID_INPUT", "Unknown command; run coord --help");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Never print arbitrary backend, provider, subprocess or filesystem error content.
    const failure = backendFailure(error);
    console.error(JSON.stringify({ error: failure.code, message: failure.message }));
    process.exitCode = 1;
  });
}
