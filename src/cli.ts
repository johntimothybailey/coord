#!/usr/bin/env node
import { runDoctor } from "./doctor.js";
import { CLIENT_VERSION, CoordError } from "./protocol.js";
import { connectWorkspace } from "./client.js";
import { pathToFileURL } from "node:url";
import { runStdioMcp } from "./mcp.js";
import { runCoordHook } from "./hooks.js";
import { loadSession, registerManual } from "./session.js";
import { exportProject, syncApprovedRules } from "./operations.js";
import { resolveWorkspace } from "./config.js";
import { setupCommand } from "./onboarding.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv;
  if (command === "--version") { console.log(CLIENT_VERSION); return; }
  if (command === "setup") { await setupCommand(args); return; }
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
    const workspace = await resolveWorkspace(process.cwd()), client = await connectWorkspace(workspace.root);
    const run = await loadSession(workspace.root, client, process.env.COORD_SESSION_ID);
    if (!run) throw new CoordError("LEASE_REVOKED", "A current participating run is required for rule synchronization");
    console.log(JSON.stringify(await syncApprovedRules(workspace.root, workspace.config.ruleTargets, run))); return;
  }
  if (command === "mcp") {
    if (args.length) throw new CoordError("INVALID_INPUT", "Usage: coord mcp");
    const root = process.cwd(), client = await connectWorkspace(root), sessionId = process.env.COORD_SESSION_ID;
    await runStdioMcp({ client, run: await loadSession(root, client, sessionId), registerManual: input => registerManual(root, client, sessionId, input) });
    return;
  }
  if (command === "hook") {
    const harness = args[0] === "codex" ? "codex" : args[0] === "antigravity" ? "antigravity" : undefined;
    if (!harness || args.length > 2) throw new CoordError("INVALID_INPUT", "Usage: coord hook codex|antigravity [event]");
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of process.stdin) { const buffer = Buffer.from(chunk as Uint8Array); bytes += buffer.length; if (bytes > 64 * 1024) throw new CoordError("INVALID_INPUT", "Hook input exceeds 64 KiB"); chunks.push(buffer); }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
    const event = args[1] ?? (typeof input.hook_event_name === "string" ? input.hook_event_name : "SessionStart");
    const root = process.cwd(), client = await connectWorkspace(root);
    console.log(JSON.stringify(await runCoordHook({ harness, event, input, run: await loadSession(root, client, process.env.COORD_SESSION_ID) })));
    return;
  }
  if (!command || command === "--help" || command === "help") {
    console.log("coord — private v2.5 implementation\n\n  doctor [--json] [--no-fixtures]\n  setup inspect <plan.json>\n  setup bootstrap|connect <plan.json> <absolute-encrypted-vault>\n  status\n  mcp\n  hook codex|antigravity [event]\n  rules sync\n  export <new-local-file.jsonl>\n  --version\n\nProtected setup must run in a separate operator terminal. See docs/onboarding.md. Full release gates are tracked in docs/execution.md."); return;
  }
  throw new CoordError("INVALID_INPUT", "Unknown command; run coord --help");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Never print arbitrary backend, provider, subprocess or filesystem error content.
    const code = error instanceof CoordError ? error.code : "OPERATION_FAILED";
    console.error(JSON.stringify({ error: code, message: error instanceof CoordError ? error.message : "Operation failed; inspect local configuration and redacted evidence" }));
    process.exitCode = 1;
  });
}
