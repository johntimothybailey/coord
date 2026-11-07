import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commandsFixture } from "./commands.fixture.js";
import { simulatedLinux } from "./commands-sandbox.fixture.js";
import { connectWorkspace } from "../src/client.js";
import { readSessionBinding } from "../src/session.js";
import { gitText } from "../src/checkpoint.js";

// All authority/sandbox/host responses here are fixtures. The actual taskboard tests run separately.
test("T6/T15 parsed checkpoint→fresh resume→distinct review reconciles lost acceptance without another PR or capacity release", async t => {
  const sandbox = simulatedLinux(t), f = await commandsFixture();
  let step = "source admission";
  try {
    const source = await f.cli(f.repo, ["resume", "task", "--prepare-only", "--runtime", f.runtimePath, "--session", "source_review"]) as { path: string };
    const sourceAgent = await connectWorkspace(source.path), sourceRun = (await readSessionBinding(source.path, sourceAgent, "source_review"))!;
    await writeFile(join(source.path, "store.js"), (await readFile(join(source.path, "store.js"), "utf8")) + "\n// End-to-end publication fixture\n");
    await sourceRun.client.mutation("tasks:progress", { ...sourceRun.identity, expectedRevision: 0, progress: JSON.stringify({ completed: ["Changed store"], remaining: ["Publish exact artifact"] }) }, "source_review_progress");
    step = "source checkpoint";
    await f.cli(source.path, ["checkpoint", "cp_original", "--runtime", f.runtimePath, "--session", "source_review"]);
    await f.cli(source.path, ["run", "finalize", "stopped", "--runtime", f.runtimePath, "--session", "source_review"]);
    step = "fresh resume";
    const destination = await f.cli(f.repo, ["resume", "task", "--prepare-only", "--checkpoint", "cp_original", "--runtime", f.runtimePath, "--session", "destination_review"]) as { path: string };
    step = "destination checkpoint";
    await f.cli(destination.path, ["checkpoint", "cp_destination", "--runtime", f.runtimePath, "--session", "destination_review"]);
    step = "review lost acceptance";
    f.loseReply("publications:accept");
    await assert.rejects(f.cli(destination.path, ["review", "publication_distinct", "--checkpoint", "cp_destination", "--runtime", f.runtimePath, "--session", "destination_review"]));
    assert.equal(f.backend.find("publications", "publication_distinct").state, "accepted");
    step = "review acceptance reconciliation";
    const accepted = await f.cli(destination.path, ["review", "publication_distinct", "--checkpoint", "cp_destination", "--runtime", f.runtimePath, "--session", "destination_review"]) as { state: string; capacityHeld: boolean };
    assert.equal(accepted.state, "review_ready");
    assert.equal(f.calls.filter(call => call.path === "lifecycle:confirmStopped").length, 0);
    assert.equal(f.calls.filter(call => call.path === "publications:accept").length, 2);
    const prs = JSON.parse(await readFile(join(f.runtime.policy.githubHome, "fixture-reviews.json"), "utf8")) as unknown[];
    assert.equal(prs.length, 1);
    const artifact = f.backend.find("checkpoints", "cp_destination"), publication = f.backend.find("publications", "publication_distinct");
    assert.equal(publication.head, artifact.commit);
    assert.equal(await gitText(f.bare, ["show", "-s", "--format=%P", `refs/heads/${publication.branch}`]), artifact.executionBase.sha);
    assert.ok(sandbox.commands.length >= 2);
  } catch (error) { throw new Error(`Synthetic full command graph failed at ${step}`, { cause: error }); }
  finally { await f.restore(); sandbox.restore(); }
});
