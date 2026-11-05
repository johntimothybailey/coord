import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendClient } from "../src/client.js";
import { exportProject, syncApprovedRules } from "../src/operations.js";
import type { RunBinding } from "../src/session.js";

async function temporary(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "coord-operations-adversarial-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test("T17 nonadvancing export retains an incomplete private file with no completion marker", async () => {
  await temporary(async root => {
    let requests = 0;
    const client = { config: { backendId: "b", projectId: "p" }, async query(_name: string, args: { table: string }) { requests++; return { projectId: "p", table: args.table, page: [], isDone: false, continueCursor: "stuck" }; } } as unknown as Pick<BackendClient, "query" | "config">;
    const path = join(root, "partial.jsonl");
    await assert.rejects(exportProject(client, path), { code: "COVERAGE_INCOMPLETE" });
    assert.equal(requests, 2); assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert(!(await readFile(path, "utf8")).includes('"type":"complete"'));
  });
});
test("T16 rule sync requires complete exact approvals and bounded policy before changing human files", async () => {
  await temporary(async root => {
    const path = join(root, "AGENTS.md"), human = "Human-maintained instruction.\n"; await writeFile(path, human);
    const approved = { complete: true, policyVersion: 2, ruleTargets: ["AGENTS.md"], rules: [{ id: "rule", revision: 1, content: "Approved project instruction", hash: "exact-hash", approvedHash: "exact-hash", approvedBy: "human" }] };
    let response: unknown = approved;
    const binding = { identity: { taskId: "task", runId: "run", epoch: 1, goalRevision: 1 }, client: { async query(name: string) { assert.equal(name, "memories:rules"); return response; } } } as unknown as RunBinding;
    for (const invalid of [{ ...approved, complete: false }, { ...approved, ruleTargets: [] }, { ...approved, rules: [{ ...approved.rules[0], approvedHash: "old-hash" }] }, { ...approved, rules: [{ ...approved.rules[0], approvedBy: undefined }] }, { ...approved, rules: [{ ...approved.rules[0], content: "超".repeat(5_000) }] }]) {
      response = invalid; await assert.rejects(syncApprovedRules(root, ["AGENTS.md"], binding)); assert.equal(await readFile(path, "utf8"), human);
    }
    response = approved;
    const result = await syncApprovedRules(root, ["AGENTS.md"], binding) as { policyVersion: number; allCheckoutsSynced: boolean };
    assert.equal(result.policyVersion, 2); assert.equal(result.allCheckoutsSynced, false);
    assert((await readFile(path, "utf8")).startsWith(human)); assert((await readFile(path, "utf8")).includes("Approved project instruction"));
    const receipt = join(root, ".coord-local/policy.json"); assert.equal((await stat(receipt)).mode & 0o777, 0o600);
    assert.equal((JSON.parse(await readFile(receipt, "utf8")) as { policyVersion: number }).policyVersion, 2);
  });
});
