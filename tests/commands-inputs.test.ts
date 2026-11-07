import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commandsFixture } from "./commands.fixture.js";
import { readSessionBinding } from "../src/session.js";
import { git } from "../src/checkpoint.js";
import * as tasks from "../convex/tasks.js";

test("T12 parsed parent prefetches and briefs its exact historical input pin; missing ref never reserves or substitutes newer latest", async () => {
  const f = await commandsFixture();
  try {
    const childTask = f.backend.find("tasks", "task");
    await f.backend.call(tasks.propose, { ...f.identity(), taskId: "parent", goalId: "goal", goalRevision: 1, title: "Consume exact published store input", scope: ["public"], dependencies: [{ taskId: "task", mode: "published" }], executionBase: childTask.executionBase });
    await assert.rejects(f.cli(f.repo, ["resume", "parent", "--prepare-only", "--runtime", f.runtimePath, "--session", "parent_before_ready"]), { code: "BLOCKED_CHECKPOINT" });
    assert.equal(f.calls.filter(call => call.path === "tasks:registerManual").length, 0);
    const source = await f.cli(f.repo, ["resume", "task", "--prepare-only", "--runtime", f.runtimePath, "--session", "input_source"]) as { path: string };
    const child = (await readSessionBinding(source.path, await f.connect(source.path), "input_source"))!;
    await writeFile(join(source.path, "store.js"), (await readFile(join(source.path, "store.js"), "utf8")) + "\n// Pinned input revision one\n");
    await child.client.mutation("tasks:progress", { ...child.identity, expectedRevision: 0, progress: "Published input revision one" }, "input_progress_one");
    await f.cli(source.path, ["checkpoint", "input_original", "--runtime", f.runtimePath, "--session", "input_source"]);
    await f.backend.call(tasks.refreshDependencies, f.identity());
    const pinned = f.backend.find("tasks", "parent").dependencies[0]!.artifact;
    assert.equal(pinned, "input_original");
    await writeFile(join(source.path, "store.js"), (await readFile(join(source.path, "store.js"), "utf8")) + "\n// Newer latest input must not replace original pin\n");
    await child.client.mutation("tasks:progress", { ...child.identity, expectedRevision: 1, progress: "Published newer input revision" }, "input_progress_two");
    await f.cli(source.path, ["checkpoint", "input_newer", "--runtime", f.runtimePath, "--session", "input_source"]);
    await f.backend.call(tasks.refreshDependencies, f.identity());
    assert.equal(f.backend.find("tasks", "parent").dependencies[0]!.artifact, "input_original");
    await f.cli(source.path, ["run", "finalize", "stopped", "--runtime", f.runtimePath, "--session", "input_source"]);
    await rename(source.path, `${source.path}-offline`);
    const original = f.backend.find("checkpoints", "input_original"), newer = f.backend.find("checkpoints", "input_newer");
    await git(f.bare, ["update-ref", "-d", original.ref]);
    const before = f.calls.filter(call => call.path === "tasks:registerManual" && call.args.taskId === "parent").length;
    await assert.rejects(f.cli(f.repo, ["resume", "parent", "--prepare-only", "--runtime", f.runtimePath, "--session", "parent_missing_input"]));
    assert.equal(f.calls.filter(call => call.path === "tasks:registerManual" && call.args.taskId === "parent").length, before);
    await git(f.bare, ["update-ref", original.ref, original.commit]);
    const consumed = await f.cli(f.repo, ["resume", "parent", "--runtime", f.runtimePath, "--session", "parent_exact_input"]) as { path: string; exitCode: number };
    assert.equal(consumed.exitCode, 0);
    const started = JSON.parse(await readFile(join(consumed.path, ".coord-local/harness-start.json"), "utf8")) as { argv: string[] };
    const briefing = JSON.parse(started.argv.at(-1)!) as { dependencies: { dependency: { artifact: string }; code: { commit: string; checkpointId: string } }[] };
    assert.equal(briefing.dependencies[0]!.dependency.artifact, "input_original");
    assert.equal(briefing.dependencies[0]!.code.commit, original.commit);
    assert.notEqual(briefing.dependencies[0]!.code.commit, newer.commit);
    assert.ok(f.calls.some(call => call.path === "checkpoints:getInput" && call.args.includeManifest === true));
  } finally { await f.restore(); }
});
