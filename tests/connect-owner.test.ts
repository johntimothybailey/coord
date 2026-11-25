import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "../src/canonical.js";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectOwnerCommand, parseLinkPlan, linkPlanDigest } from "../src/connect-owner.js";
import { CoordError } from "../src/protocol.js";

function plan() { return { schemaVersion: 1 as const, deploymentName: "fixture-deployment", link: { id: "exact_link", generation: 1, userId: "publicUser123", backendId: "backend", projectId: "project", sourceCredentialId: "agent", scopes: ["coord:read"], activationExpiresAt: Date.now() + 60_000, expiresAt: Date.now() + 120_000 } }; }
// New reviewed shape: an authoritative highestGeneration, the complete affected unrevoked
// set, a bounded history preview and its truncation flag. `before` makes a self-consistent
// change (the digest covers it, so only safeOwnerReview's own validation can refuse it);
// `after` changes the review once the digest is fixed, which must break digest parity.
function inspection(input: ReturnType<typeof plan>, highestGeneration = 0, options: { generations?: number[]; truncated?: boolean; before?: (review: Record<string, unknown>) => void; after?: (review: Record<string, unknown>) => void } = {}) {
  const generations = options.generations ?? (highestGeneration ? [highestGeneration] : []);
  const row = (generation: number) => ({ id: `prior_${generation}`, generation, projectId: input.link.projectId, sourceCredentialId: input.link.sourceCredentialId, active: true, expiresAt: input.link.expiresAt });
  const review: Record<string, unknown> = { userId: input.link.userId, backendId: input.link.backendId, projectId: input.link.projectId, sourceCredentialId: input.link.sourceCredentialId, userEnabled: true, highestGeneration, source: { documentId: "publicDoc123", credentialId: "agent", memberId: "member", role: "agent", projectIds: ["project"], expiresAt: input.link.expiresAt + 1000, revokedAt: null, lapsedAt: null }, project: { repository: "https://example.test/repo", remote: "origin", defaultBranch: "main" }, affected: generations.map(row), existing: generations.map(generation => ({ ...row(generation), revokedAt: null })), existingTruncated: options.truncated ?? false };
  options.before?.(review);
  const digest = createHash("sha256").update(canonicalJson(review)).digest("hex");
  options.after?.(review);
  return { review, highestGeneration, digest };
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
    const report = output.join("");
    assert.match(report, /"nextGeneration":5/); assert.match(report, /No authority was installed or changed/);
    assert.match(report, /Authoritative highest installed generation: 4/); assert.match(report, /Exact next generation: 5/);
    assert.match(report, /Complete affected unrevoked links that installing the next generation revokes \(1;/);
    assert.match(report, /generation 4 · link prior_4 · project project · source agent · activated/);
    assert.match(report, /Generation history preview — at most the newest 20 generations, revoked ones included \(1\)/);
    assert.doesNotMatch(report, /Older generations exist outside this preview/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("owner review rejects malformed generation state, oversized affected sets and server order that breaks digest parity", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "coord-connect-shape-")));
  try {
    const input = plan(), target = join(root, "plan.json"); await writeFile(target, JSON.stringify(input));
    const bad: [string, "INVALID_INPUT" | "BLOCKED_ENV", () => ReturnType<typeof inspection>][] = [
      // safeOwnerReview's own validation refuses these outright, before any confirmation.
      ["missing existingTruncated", "INVALID_INPUT", () => inspection(input, 4, { before: review => { delete review.existingTruncated; } })],
      ["non-boolean existingTruncated", "INVALID_INPUT", () => inspection(input, 4, { before: review => { review.existingTruncated = "yes"; } })],
      ["fractional highestGeneration", "INVALID_INPUT", () => inspection(input, 4, { before: review => { review.highestGeneration = 4.5; } })],
      ["negative highestGeneration", "INVALID_INPUT", () => inspection(input, 4, { before: review => { review.highestGeneration = -1; } })],
      ["oversized affected set", "INVALID_INPUT", () => inspection(input, 4, { before: review => { review.affected = Array.from({ length: 101 }, (_unused, index) => ({ id: `over_${index}`, generation: index + 1, projectId: "project", sourceCredentialId: "agent", active: true, expiresAt: input.link.expiresAt })); } })],
      ["oversized history preview", "INVALID_INPUT", () => inspection(input, 21, { generations: Array.from({ length: 21 }, (_unused, index) => index + 1) })],
      // An affected row carrying revokedAt contradicts the unrevoked-by-contract shape: the
      // safe reconstruction drops the field, so digest parity fails and nothing is installed.
      ["affected row carrying revokedAt", "BLOCKED_ENV", () => inspection(input, 4, { before: review => { (review.affected as Record<string, unknown>[])[0]!.revokedAt = null; } })],
      // The preview holds the newest generations, so its maximum must be the authority.
      ["highestGeneration disagreeing with existing", "BLOCKED_ENV", () => inspection(input, 4, { after: review => { review.highestGeneration = 7; } })],
      ["highestGeneration above the preview", "BLOCKED_ENV", () => inspection(input, 7, { generations: [4] })],
      // Array order is the server's and is never re-sorted locally, so a reordered server
      // array cannot silently match the digest it was supposed to cover.
      ["reordered affected array", "BLOCKED_ENV", () => inspection(input, 5, { generations: [4, 5], after: review => { (review.affected as unknown[]).reverse(); } })],
      ["reordered history array", "BLOCKED_ENV", () => inspection(input, 5, { generations: [4, 5], after: review => { (review.existing as unknown[]).reverse(); } })],
    ];
    for (const [label, expected, make] of bad) {
      let prompts = 0, installs = 0; const output: string[] = [];
      await assert.rejects(connectOwnerCommand(["inspect-owner", target], { write: text => output.push(text), prompt: async label2 => { prompts++; return label2; }, ownerCall: async (_deployment, operation) => { if (operation === "connect:inspectOwnerLink") return make(); installs++; return {}; } }), error => error instanceof CoordError && error.code === expected, label);
      assert.equal(prompts, 0, label); assert.equal(installs, 0, label);
      assert(!output.join("").includes("Authoritative highest installed generation"), label);
    }
    // The same review, unchanged, is accepted: the refusals above are not blanket failures.
    const accepted: string[] = [];
    await connectOwnerCommand(["inspect-owner", target], { write: text => accepted.push(text), prompt: async () => { throw new Error("Inspection has no confirmation action"); }, ownerCall: async () => inspection(input, 5, { generations: [4, 5], truncated: true }) });
    assert.match(accepted.join(""), /Complete affected unrevoked links that installing the next generation revokes \(2;/);
    assert.match(accepted.join(""), /Older generations exist outside this preview and are not displayed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
