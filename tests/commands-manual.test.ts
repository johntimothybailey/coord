import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commandsFixture } from "./commands.fixture.js";
import { simulatedLinux } from "./commands-sandbox.fixture.js";
import { connectRuntimeBridge } from "../src/commands.js";

test("T19 accepted manual PR is finalized successfully at renewal without downgrading task or claiming tree exit", async t => {
  const sandbox = simulatedLinux(t), f = await commandsFixture();
  let completed = false, pending: Promise<unknown> | undefined;
  try {
    await writeFile(f.runtime.harness.executable, `#!${process.execPath}\nimport{writeFileSync}from'node:fs';if(process.argv.includes('--version'))console.log('codex-cli 1.0.0');else{writeFileSync('.coord-local/manual-monitor-started.json',JSON.stringify({fixture:true}));setInterval(()=>{},1000)}\n`);
    t.mock.timers.enable({ apis: ["setInterval"] });
    pending = f.cli(f.repo, ["resume", "task", "--runtime", f.runtimePath, "--session", "manual_monitor"]);
    let path: string | undefined;
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      const run = [...f.backend.rows.values()].find(row => row._table === "runs");
      if (run) { const candidate = join(f.runtime.worktreeRoot, `task-e${run.epoch}-${run.id}`); try { await readFile(join(candidate, ".coord-local/manual-monitor-started.json")); path = candidate; break; } catch {} }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(path, "Fresh fixture harness actually started");
    const bridge = await connectRuntimeBridge(path, f.runtimePath, "manual_monitor");
    await writeFile(join(path, "store.js"), (await readFile(join(path, "store.js"), "utf8")) + "\n// Accepted manual monitor regression\n");
    await bridge.run.client.mutation("tasks:progress", { ...bridge.run.identity, expectedRevision: 0, progress: "Manual result ready for exact publication" }, "manual_monitor_progress");
    await bridge.runtimeActions.checkpoint({ checkpointId: "manual_monitor_cp" });
    await bridge.runtimeActions.review({ checkpointId: "manual_monitor_cp", publicationId: "manual_monitor_pr" });
    assert.equal(f.backend.find("tasks", "task").state, "review_ready");
    t.mock.timers.tick(20_000);
    const result = await pending as { descendantStopProven: boolean };
    completed = true;
    assert.equal(result.descendantStopProven, false);
    assert.equal(f.backend.find("tasks", "task").state, "review_ready");
    assert.equal(f.backend.find("tasks", "task").publicationId, "manual_monitor_pr");
    assert.equal(f.backend.find("runs", bridge.run.identity.runId).state, "succeeded");
    assert.equal(f.backend.find("tasks", "task").ownerRunId, undefined);
    assert.equal(f.calls.filter(call => call.path === "lifecycle:confirmStopped").length, 0);
  } finally {
    if (pending && !completed) {
      for (const row of [...f.backend.rows.values()].filter(row => row._table === "credentials" && row.role === "run")) await f.backend.context().db.patch(row._id as never, { revokedAt: Date.now() });
      t.mock.timers.tick(20_000); await pending.catch(() => {});
    }
    t.mock.timers.reset(); await f.restore(); sandbox.restore();
  }
});
