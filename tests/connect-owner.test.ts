import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "../src/canonical.js";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectOwnerCommand, parseLinkPlan, linkPlanDigest } from "../src/connect-owner.js";

function plan() { return { schemaVersion: 1 as const, deploymentName: "fixture-deployment", link: { id: "exact_link", generation: 1, userId: "publicUser123", backendId: "backend", projectId: "project", sourceCredentialId: "agent", scopes: ["coord:read"], activationExpiresAt: Date.now() + 60_000, expiresAt: Date.now() + 120_000 } }; }
function inspection(input: ReturnType<typeof plan>, highestGeneration = 0) {
  const review = { userId: input.link.userId, backendId: input.link.backendId, projectId: input.link.projectId, sourceCredentialId: input.link.sourceCredentialId, userEnabled: true, source: { documentId: "publicDoc123", credentialId: "agent", memberId: "member", role: "agent", projectIds: ["project"], expiresAt: input.link.expiresAt + 1000, revokedAt: null, lapsedAt: null }, project: { repository: "https://example.test/repo", remote: "origin", defaultBranch: "main" }, existing: highestGeneration ? [{ id: "prior", generation: highestGeneration, projectId: "project", sourceCredentialId: "agent", active: true, revokedAt: null, expiresAt: input.link.expiresAt }] : [] };
  return { review, highestGeneration, digest: createHash("sha256").update(canonicalJson(review)).digest("hex") };
}
const confirm = async (label: string) => label.slice("Type ".length, label.indexOf(" to authorize"));

test("nonsecret plan generation is explicit, exclusive and grants no authority", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "coord-connect-plan-")));
  try {
    const output: string[] = [], target = join(root, "plan.json"), input = plan();
    const args = ["plan", "--deployment", input.deploymentName, "--backend", "backend", "--project", "project", "--user", input.link.userId, "--source", "agent", "--generation", "1", "--scopes", "coord:read", "--activation-expires-at", new Date(input.link.activationExpiresAt).toISOString(), "--expires-at", new Date(input.link.expiresAt).toISOString(), "--out", target];
    let ownerCalls = 0;
    await connectOwnerCommand(args, { write: text => output.push(text), ownerCall: async () => { ownerCalls++; throw new Error("unexpected"); } });
    const saved = parseLinkPlan(JSON.parse(await readFile(target, "utf8")));
    assert.equal(saved.link.userId, input.link.userId); assert.equal(ownerCalls, 0);
    assert(output.join("").includes("No authority was installed"));
    await assert.rejects(connectOwnerCommand(args, { write: () => {} }));
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), saved);
    assert.throws(() => parseLinkPlan({ ...input, token: "never accept credentials" }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("protected owner command confirms reviewed replacement effects and reconciles a lost mutation reply by exact readback", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "coord-connect-owner-")));
  try {
    const input = plan(), target = join(root, "plan.json"); await writeFile(target, JSON.stringify(input));
    let installed = false, prompts = 0; const called: string[] = [], output: string[] = [];
    await connectOwnerCommand(["link", target], {
      prompt: async label => { prompts++; assert(label.includes(linkPlanDigest(input))); assert(output.join("").includes("revokes ALL prior")); return confirm(label); },
      write: text => output.push(text),
      ownerCall: async (_deployment, operation, args) => {
        called.push(operation);
        if (operation === "connect:inspectLink") return installed ? { ...input.link, linkId: "doc_link", active: false, eligible: true, lifecycle: "current" } : null;
        if (operation === "connect:inspectOwnerLink") return inspection(input);
        assert.equal(operation, "connect:installOwnerLink"); assert.equal(args.expectedStateDigest, inspection(input).digest); installed = true; throw new Error("lost reply containing secret provider output must be hidden");
      },
    });
    assert.equal(prompts, 1); assert(installed);
    assert.deepEqual(called, ["connect:inspectLink", "connect:inspectOwnerLink", "connect:installOwnerLink", "connect:inspectLink"]);
    assert(output.join("").includes('"state":"link_installed"')); assert(!output.join("").includes("secret provider"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("declining or stale generation never invokes install; mismatched readback never claims success", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "coord-connect-deny-")));
  try {
    const input = plan(), target = join(root, "plan.json"); await writeFile(target, JSON.stringify(input));
    for (const mode of ["decline", "stale", "mismatch"] as const) {
      let installs = 0; const output: string[] = [];
      await assert.rejects(connectOwnerCommand(["link", target], { write: text => output.push(text), prompt: mode === "decline" ? async () => "no" : confirm, ownerCall: async (_deployment, operation) => {
        if (operation === "connect:inspectLink") return installs ? { ...input.link, projectId: "wrong", linkId: "row", active: false, eligible: true, lifecycle: "current" } : null;
        if (operation === "connect:inspectOwnerLink") return inspection(input, mode === "stale" ? 4 : 0);
        installs++; return {};
      } }));
      assert.equal(installs, mode === "mismatch" ? 1 : 0); assert(!output.join("").includes('"state":"link_installed"'));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("late lost-reply reconciliation preserves the expired activation plan and distinguishes unusable records", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "coord-connect-late-")));
  try {
    const input = plan(); input.link.activationExpiresAt = Date.now() - 1000;
    const target = join(root, "plan.json"); await writeFile(target, JSON.stringify(input));
    for (const lifecycle of ["current", "expired", "revoked"] as const) {
      const output: string[] = []; let installs = 0;
      const action = connectOwnerCommand(["link", target], { write: text => output.push(text), prompt: confirm, ownerCall: async (_deployment, operation) => {
        if (operation !== "connect:inspectLink") { installs++; throw new Error("No mutation on expired activation plan"); }
        return { ...input.link, linkId: "existing", active: true, eligible: lifecycle === "current", lifecycle };
      } });
      if (lifecycle === "current") { await action; assert(output.join("").includes('"active":true')); }
      else { await assert.rejects(action, error => String(error).includes(lifecycle)); assert(!output.join("").includes('"state":"link_installed"')); }
      assert.equal(installs, 0);
    }
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), input);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("owner inspection rejects foreign selectors and altered review digests before confirmation or installation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "coord-connect-review-")));
  try {
    const input = plan(), target = join(root, "plan.json"); await writeFile(target, JSON.stringify(input));
    for (const mode of ["foreign", "digest"] as const) {
      let prompts = 0, installs = 0;
      await assert.rejects(connectOwnerCommand(["link", target], { write: () => {}, prompt: async label => { prompts++; return confirm(label); }, ownerCall: async (_deployment, operation) => {
        if (operation === "connect:inspectLink") return null;
        if (operation === "connect:inspectOwnerLink") { const result = inspection(input); if (mode === "foreign") result.review.userId = "other"; else result.digest = "a".repeat(64); return result; }
        installs++; return {};
      } }));
      assert.equal(prompts, 0); assert.equal(installs, 0);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("protected owner inspection provides the executable next-generation answer without changing authority", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "coord-connect-inspect-")));
  try {
    const input = plan(), target = join(root, "plan.json"); await writeFile(target, JSON.stringify(input));
    const output: string[] = [], calls: string[] = [];
    await connectOwnerCommand(["inspect-owner", target], { prompt: async () => { throw new Error("Inspection has no confirmation action"); }, write: text => output.push(text), ownerCall: async (_deployment, operation) => { calls.push(operation); return inspection(input, 4); } });
    assert.deepEqual(calls, ["connect:inspectOwnerLink"]);
    assert.match(output.join(""), /"nextGeneration":5/); assert.match(output.join(""), /No authority was installed or changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
