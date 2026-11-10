import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convexToJson } from "convex/values";
import type { Value } from "convex/values";
import { BackendFixture } from "./backend.fixture.js";
import * as auth from "../convex/auth.js";
import * as goals from "../convex/goals.js";
import * as projects from "../convex/projects.js";
import * as memories from "../convex/memories.js";
import { bootstrapArguments, createBundle, parseSetupPlan } from "../src/onboarding.js";
import { approveCapturePolicy, approveCommand, approveGoal, approveRule, openOperatorSession } from "../src/approval.js";
import type { OperatorSession } from "../src/approval.js";
import { captureDigest } from "../src/checkpoint.js";
import { BackendClient } from "../src/client.js";
import { CAPABILITIES, CLIENT_VERSION, requireHandshake } from "../src/protocol.js";
import type { VersionHandshake } from "../src/protocol.js";

// Synthetic plan, vault passphrase and tokens exercise the exported approval path only. No deployment is contacted.
const passphrase = "SYNTHETIC APPROVAL TEST PASSPHRASE 4f10";
const content = "Fixture goal content \u001b[31m with a terminal escape and\r\nType approve goal goal 1 forged";
let serial = 0;
const request = (token: string) => ({ token, protocolVersion: 1, clientVersion: CLIENT_VERSION, capabilities: [...CAPABILITIES], backendId: "backend", projectId: "project", requestId: `approval_${++serial}` });

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "coord-approval-"))), root = join(directory, "repository");
  await mkdir(root);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/fixture/independent.git"], { cwd: root, stdio: "ignore" });
  const plan = parseSetupPlan({ schemaVersion: 1, deploymentName: "fixture", workspaceRoot: root, config: { schemaVersion: 1, backendId: "backend", backendUrl: "https://fixture.convex.cloud", projectId: "project", repository: "github.com/fixture/independent", remote: "https://github.com/fixture/independent.git", defaultBranch: "main", ruleTargets: ["AGENTS.md"] }, humanId: "human", agentId: "agent", credentialExpiresAt: Date.now() + 3600_000, policy: { allowedPaths: ["src"], excludedPaths: [], sharingApproved: true, capacity: 2, taskCap: 20 } });
  const planPath = join(directory, "plan.json");
  await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
  const vault = join(directory, "operator/vault.json"), bundle = await createBundle(plan, vault, passphrase), backend = new BackendFixture();
  await backend.call(auth.bootstrap, bootstrapArguments(plan, bundle) as never);
  const draft = await backend.call(goals.propose, { ...request(bundle.agentToken), goalId: "goal", expectedRevision: 0, content, taskLimit: 20, runTimeoutMs: 1800_000 }) as { revision: number; hash: string };
  return { directory, plan, planPath, vault, bundle, backend, draft };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const handlers: Record<string, typeof auth.handshake> = { "memories:ruleForApproval": memories.ruleForApproval as unknown as typeof auth.handshake, "memories:approveRule": memories.approveRule as unknown as typeof auth.handshake, "auth:handshake": auth.handshake, "projects:status": projects.status as unknown as typeof auth.handshake, "goals:approve": goals.approve as unknown as typeof auth.handshake, "projects:configure": projects.configure as unknown as typeof auth.handshake };
async function wire(f: Fixture, run: (calls: Array<{ path: string; args: Record<string, unknown> }>) => Promise<void>, reply: (path: string, value: Value) => Value = (_path, value) => value): Promise<void> {
  const original = globalThis.fetch, calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).origin, f.plan.config.backendUrl);
    const body = JSON.parse(String(init?.body)) as { path: string; args: Array<Record<string, unknown>> }, args = body.args[0]!;
    calls.push({ path: body.path, args });
    const handler = handlers[body.path];
    assert(handler, "Only expected approval endpoints may be called");
    try { return new Response(JSON.stringify({ status: "success", value: convexToJson(reply(body.path, await f.backend.call(handler, args as never) as Value)), logLines: [] })); }
    catch (error) {
      if (!(error as { data?: unknown }).data) throw error;
      return new Response(JSON.stringify({ status: "error", errorMessage: "Fixture denied", errorData: (error as { data: Value }).data, logLines: [] }));
    }
  };
  try { await run(calls); } finally { globalThis.fetch = original; }
}

/** Scripted protected prompt: the real command reads the passphrase only from a hidden operator terminal. */
function operator(confirmation: string) {
  const asked: Array<{ label: string; hidden: boolean }> = [], shown: string[] = [];
  return { asked, shown, io: { write: (text: string) => { shown.push(text); }, prompt: async (label: string, hidden: boolean) => { asked.push({ label, hidden }); return hidden ? passphrase : confirmation; } } };
}
const phrase = (f: Fixture) => `approve goal goal ${f.draft.revision} ${f.draft.hash}`;

test("an owner approval shows the effective policy and returns the exact stored approver and server time", async () => {
  const f = await fixture();
  await f.backend.call(projects.configure, { ...request(f.bundle.humanToken), repository: f.plan.config.repository, remote: f.plan.config.remote, defaultBranch: f.plan.config.defaultBranch, allowedPaths: ["src", "tests"], excludedPaths: ["private"], ruleTargets: ["AGENTS.md", "CLAUDE.md"], sharingApproved: true, capturePolicyDigest: "a".repeat(64), capacity: 3, taskCap: 21 });
  const printed: string[] = [], log = console.log;
  console.log = (...values: unknown[]) => { printed.push(values.map(String).join(" ")); };
  try {
    await wire(f, async calls => {
      const terminal = operator(phrase(f));
      const prompt = terminal.io.prompt;
      terminal.io.prompt = async (label, hidden) => {
        if (!hidden) assert(terminal.shown.join("").includes("Effective project policy"), "policy must precede confirmation");
        return prompt(label, hidden);
      };
      await approveCommand(["goal", "goal", "--plan", f.planPath, "--vault", f.vault, "--revision", String(f.draft.revision), "--hash", f.draft.hash], terminal.io);
      const mutations = calls.filter(call => call.path === "goals:approve");
      assert.equal(mutations.length, 1);
      assert.deepEqual({ goalId: mutations[0]!.args.goalId, revision: mutations[0]!.args.revision, hash: mutations[0]!.args.hash }, { goalId: "goal", revision: f.draft.revision, hash: f.draft.hash });
      const stored = f.backend.find("goals", "goal");
      assert(Number.isSafeInteger(stored.approvedAt) && stored.approvedAt! > 0);
      assert.deepEqual(JSON.parse(printed.at(-1)!), { goalId: "goal", revision: f.draft.revision, hash: f.draft.hash, state: "active", approvedBy: stored.approvedBy, approvedAt: stored.approvedAt, mutated: true });
      assert.equal(stored.state, "active"); assert.equal(stored.approvedHash, f.draft.hash); assert.equal(stored.approvedBy, "human");
      assert.deepEqual(terminal.asked.map(ask => ask.hidden), [true, false]);
      const display = terminal.shown.join("");
      assert(display.includes(f.draft.hash) && display.includes(`revision ${f.draft.revision}`));
      assert(display.includes('"tests"'), "show the widened backend scope, not the stale plan");
      for (const policyValue of ['"private"', '"CLAUDE.md"', '"sharingApproved": true', '"capacity": 3', '"taskCap": 21', '"configVersion": 2', '"policyVersion": 2', "a".repeat(64)]) assert(display.includes(policyValue));
      assert(display.includes("\\u001b[31m") && !display.includes("\u001b"), "untrusted goal content must not emit terminal escapes");
      for (const text of [...printed, ...terminal.shown, ...terminal.asked.map(ask => ask.label)]) assert(!text.includes(f.bundle.humanToken) && !text.includes(f.bundle.agentToken) && !text.includes(passphrase));
    });
  } finally { console.log = log; await rm(f.directory, { recursive: true, force: true }); }
});

test("a stated revision or hash that is not the current draft is refused before any mutation or display, after the passphrase alone", async () => {
  const f = await fixture();
  try {
    await wire(f, async calls => {
      for (const target of [{ revision: f.draft.revision + 1, hash: f.draft.hash }, { revision: f.draft.revision, hash: `${f.draft.hash.slice(0, 63)}${f.draft.hash.endsWith("a") ? "b" : "a"}` }]) {
        const terminal = operator(phrase(f));
        await assert.rejects(approveCommand(["goal", "goal", "--plan", f.planPath, "--vault", f.vault, "--revision", String(target.revision), "--hash", target.hash], terminal.io), /not this project's current goal revision/);
        assert.deepEqual(terminal.asked.map(ask => ask.hidden), [true], "only the passphrase may be requested");
        assert.deepEqual(terminal.shown, []);
      }
      assert.deepEqual(calls.filter(call => call.path === "goals:approve"), []);
      assert.equal(f.backend.find("goals", "goal").state, "draft");
    });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("declining the exact confirmation leaves the goal a draft", async () => {
  const f = await fixture();
  try {
    await wire(f, async calls => {
      const terminal = operator("no");
      await assert.rejects(approveCommand(["goal", "goal", "--plan", f.planPath, "--vault", f.vault, "--revision", String(f.draft.revision), "--hash", f.draft.hash], terminal.io), /confirmation did not match/);
      assert.deepEqual(calls.filter(call => call.path === "goals:approve"), []);
      assert.equal(f.backend.find("goals", "goal").state, "draft");
    });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("a confirmed approval carried by a nonowner credential is refused by the backend without leaking it", async () => {
  const f = await fixture();
  try {
    await wire(f, async calls => {
      const client = new BackendClient(f.plan.config, f.bundle.agentToken);
      requireHandshake(await client.query("auth:handshake") as VersionHandshake);
      const session: OperatorSession = { plan: f.plan, client, status: await client.query("projects:status") as Record<string, unknown>, write: () => {}, prompt: async () => phrase(f) };
      await assert.rejects(approveGoal(session, { goalId: "goal", revision: f.draft.revision, hash: f.draft.hash }), error => {
        const text = String(error) + JSON.stringify(error);
        assert.equal((error as { code?: string }).code, "FORBIDDEN");
        assert(!text.includes(f.bundle.agentToken) && !text.includes(f.bundle.humanToken) && !text.includes(passphrase));
        return true;
      });
      assert.equal(calls.filter(call => call.path === "goals:approve").length, 1);
      assert.equal(f.backend.find("goals", "goal").state, "draft");
      // The owner session built from the same vault is accepted, so only the role differed.
      const owner = await openOperatorSession({ plan: f.planPath, vault: f.vault }, operator(phrase(f)).io);
      assert.equal((await approveGoal(owner, { goalId: "goal", revision: f.draft.revision, hash: f.draft.hash })).state, "active");
    });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("an already bound approval replays for its own approver and never reports another member's approval as this operator's", async () => {
  const f = await fixture();
  const printed: string[] = [], log = console.log;
  console.log = (...values: unknown[]) => { printed.push(values.map(String).join(" ")); };
  try {
    await wire(f, async calls => {
      const argv = ["goal", "goal", "--plan", f.planPath, "--vault", f.vault, "--revision", String(f.draft.revision), "--hash", f.draft.hash];
      const approvals = () => calls.filter(call => call.path === "goals:approve").length;
      await approveCommand(argv, operator(phrase(f)).io);
      assert.equal(approvals(), 1);
      const original = JSON.parse(printed.at(-1)!);
      // A lost reply: the same operator reruns the same command, reads back the bound approval with its approver, and mutates nothing.
      const replay = operator(phrase(f));
      await approveCommand(argv, replay.io);
      assert.deepEqual(JSON.parse(printed.at(-1)!), { goalId: "goal", revision: f.draft.revision, hash: f.draft.hash, state: "active", approvedBy: f.plan.humanId, approvedAt: original.approvedAt, mutated: false });
      assert.equal(approvals(), 1, "a replay must never approve the same revision a second time");
      assert.deepEqual(replay.asked.map(ask => ask.hidden), [true], "only the passphrase may be requested");
      assert.deepEqual(replay.shown, []);
      // A second owner identity: another member's approval is refused distinctly, never presented as this operator's own.
      const session = await openOperatorSession({ plan: f.planPath, vault: f.vault }, operator(phrase(f)).io);
      const other: OperatorSession = { ...session, plan: { ...session.plan, humanId: "second-human" } };
      const quiet = printed.length;
      await assert.rejects(approveGoal(other, { goalId: "goal", revision: f.draft.revision, hash: f.draft.hash }), error => {
        assert.equal((error as { code?: string }).code, "IDEMPOTENCY_CONFLICT");
        assert.match((error as Error).message, /already bound to the approval of member human/);
        assert(!String(error).includes(f.bundle.humanToken) && !String(error).includes(passphrase));
        return true;
      });
      assert.equal(printed.length, quiet, "another member's approval must never be printed as this operator's success");
      assert.equal(approvals(), 1);
      const stored = f.backend.find("goals", "goal");
      assert.equal(stored.state, "active"); assert.equal(stored.approvedBy, f.plan.humanId); assert.equal(stored.approvedAt, original.approvedAt);
      const malformed: OperatorSession = { ...session, status: { ...session.status, goals: [{ ...stored, approvedAt: undefined }] } };
      await assert.rejects(approveGoal(malformed, { goalId: "goal", revision: f.draft.revision, hash: f.draft.hash }), /unreadable recorded approval metadata/);
      assert.equal(approvals(), 1, "invalid stored metadata must not cause another mutation");
    });
  } finally { console.log = log; await rm(f.directory, { recursive: true, force: true }); }
});


test("an applied approval with missing or mismatched reply metadata never prints success", async () => {
  const printed: string[] = [], log = console.log;
  console.log = (...values: unknown[]) => { printed.push(values.map(String).join(" ")); };
  try {
    for (const metadata of [{ approvedBy: undefined }, { approvedBy: "different-human" }, { approvedAt: undefined }, { approvedAt: -1 }]) {
      const f = await fixture();
      try {
        await wire(f, async calls => {
          const before = printed.length;
          await assert.rejects(approveCommand(["goal", "goal", "--plan", f.planPath, "--vault", f.vault, "--revision", String(f.draft.revision), "--hash", f.draft.hash], operator(phrase(f)).io), /did not confirm this exact goal approval/);
          assert.equal(printed.length, before, "an unconfirmed reply must not print success");
          assert.equal(calls.filter(call => call.path === "goals:approve").length, 1);
          assert.equal(f.backend.find("goals", "goal").state, "active", "the backend effect already happened; rejection does not roll it back");
        }, (path, value) => path === "goals:approve" ? Object.fromEntries(Object.entries({ ...value as Record<string, Value>, ...metadata }).filter(([, field]) => field !== undefined)) as Value : value);
      } finally { await rm(f.directory, { recursive: true, force: true }); }
    }
  } finally { console.log = log; }
});

const capturePolicy = { allowedUntracked: ["src/new.ts"], exclusions: [{ path: "private", reason: "Local only\u001b[31m" }], requiredPaths: ["src"], forbiddenContent: ["synthetic-forbidden-content"], maxFileBytes: 1024 };
async function policyInput(f: Fixture) {
  const path = join(f.directory, "capture-policy.json"), hash = captureDigest(capturePolicy);
  await writeFile(path, JSON.stringify(capturePolicy));
  return { path, hash, argv: ["policy", path, "--plan", f.planPath, "--vault", f.vault, "--hash", hash], phrase: `approve policy project ${hash}` };
}

test("capture approval preserves current project settings and vault bytes, then retries without configuration churn", async () => {
  const f = await fixture(), input = await policyInput(f);
  await f.backend.call(projects.configure, { ...request(f.bundle.humanToken), repository: f.plan.config.repository, remote: f.plan.config.remote, defaultBranch: f.plan.config.defaultBranch, allowedPaths: ["src", "tests"], excludedPaths: ["private"], ruleTargets: ["CLAUDE.md"], sharingApproved: true, capacity: 3, taskCap: 21 });
  const before = f.backend.find("projects", "project"), vault = await readFile(f.vault), plan = await readFile(f.planPath), printed: string[] = [], log = console.log;
  console.log = (...values: unknown[]) => { printed.push(values.map(String).join(" ")); };
  try {
    await wire(f, async calls => {
      const terminal = operator(input.phrase), prompt = terminal.io.prompt;
      terminal.io.prompt = async (label, hidden) => {
        if (!hidden) {
          const display = terminal.shown.join("");
          assert(display.includes(input.hash) && display.includes('"allowedUntracked"') && display.includes('"tests"') && display.includes("invalidates machine qualification"));
          assert(display.includes("\\u001b") && !display.includes("\u001b"));
        }
        return prompt(label, hidden);
      };
      await approveCommand(input.argv, terminal.io);
      const call = calls.find(call => call.path === "projects:configure")!;
      assert.equal(call.args.expectedConfigVersion, before.configVersion);
      const stored = f.backend.find("projects", "project");
      assert.deepEqual(stored, { ...before, capturePolicyDigest: input.hash, configVersion: before.configVersion! + 1, policyVersion: before.policyVersion + 1 });
      assert.deepEqual(JSON.parse(printed.at(-1)!), { projectId: "project", capturePolicyDigest: input.hash, configVersion: stored.configVersion, policyVersion: stored.policyVersion, mutated: true });
      assert.deepEqual(terminal.asked.map(ask => ask.hidden), [true, false]);
      const replay = operator(input.phrase);
      await approveCommand(input.argv, replay.io);
      assert.equal(calls.filter(call => call.path === "projects:configure").length, 1);
      assert.deepEqual(JSON.parse(printed.at(-1)!), { projectId: "project", capturePolicyDigest: input.hash, configVersion: stored.configVersion, policyVersion: stored.policyVersion, mutated: false });
      assert.deepEqual(replay.asked.map(ask => ask.hidden), [true]);
      assert.deepEqual(await readFile(f.vault), vault); assert.deepEqual(await readFile(f.planPath), plan);
      for (const text of [...printed, ...terminal.shown, ...terminal.asked.map(ask => ask.label)]) assert(!text.includes(f.bundle.humanToken) && !text.includes(f.bundle.agentToken) && !text.includes(passphrase));
    });
  } finally { console.log = log; await rm(f.directory, { recursive: true, force: true }); }
});

test("invalid capture input is rejected before unlocking and declined confirmation never configures", async () => {
  const f = await fixture(), input = await policyInput(f);
  try {
    await wire(f, async calls => {
      const terminal = operator(input.phrase);
      await assert.rejects(approveCommand([...input.argv.slice(0, -1), "0".repeat(64)], terminal.io), /does not reproduce the stated hash/);
      for (const invalid of [{ ...capturePolicy, unknown: true }, { ...capturePolicy, requiredPaths: ["../private"] }]) {
        await writeFile(input.path, JSON.stringify(invalid));
        await assert.rejects(approveCommand(input.argv, terminal.io), error => (error as { code?: string }).code === "INVALID_INPUT");
      }
      assert.equal(terminal.asked.length, 0); assert.equal(calls.length, 0);
      await writeFile(input.path, JSON.stringify(capturePolicy));
      await assert.rejects(approveCommand(input.argv, operator("no").io), /confirmation did not match/);
      assert.equal(calls.filter(call => call.path === "projects:configure").length, 0);
      assert.equal(f.backend.find("projects", "project").capturePolicyDigest, undefined);
    });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("a nonhuman credential cannot configure capture policy and its error contains no credential", async () => {
  const f = await fixture(), input = await policyInput(f);
  try {
    await wire(f, async calls => {
      const client = new BackendClient(f.plan.config, f.bundle.agentToken);
      const session: OperatorSession = { plan: f.plan, client, status: await client.query("projects:status") as Record<string, unknown>, write: () => {}, prompt: async () => input.phrase };
      await assert.rejects(approveCapturePolicy(session, capturePolicy, input.hash), error => {
        assert.equal((error as { code?: string }).code, "FORBIDDEN");
        assert(!String(error).includes(f.bundle.agentToken) && !String(error).includes(f.bundle.humanToken)); return true;
      });
      assert.equal(calls.filter(call => call.path === "projects:configure").length, 1);
      assert.equal(f.backend.find("projects", "project").capturePolicyDigest, undefined);
    });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("concurrent configuration changes are preserved and uncertain policy readback prints no success", async () => {
  const f = await fixture(), input = await policyInput(f), printed: string[] = [], log = console.log;
  console.log = (...values: unknown[]) => { printed.push(values.map(String).join(" ")); };
  try {
    await wire(f, async () => {
      const terminal = operator(input.phrase), prompt = terminal.io.prompt;
      terminal.io.prompt = async (label, hidden) => {
        if (!hidden) await f.backend.call(projects.configure, { ...request(f.bundle.humanToken), repository: f.plan.config.repository, remote: f.plan.config.remote, defaultBranch: f.plan.config.defaultBranch, allowedPaths: ["other"], excludedPaths: [], ruleTargets: ["AGENTS.md"], sharingApproved: true, capacity: 4, taskCap: 25 });
        return prompt(label, hidden);
      };
      await assert.rejects(approveCommand(input.argv, terminal.io), error => (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT");
      assert.deepEqual(f.backend.find("projects", "project").allowedPaths, ["other"]);
      assert.equal(f.backend.find("projects", "project").capturePolicyDigest, undefined);
      assert.deepEqual(printed, []);
    });
    let statuses = 0;
    await wire(f, async () => {
      await assert.rejects(approveCommand(input.argv, operator(input.phrase).io), /did not confirm this exact capture policy configuration/);
      assert.equal(f.backend.find("projects", "project").capturePolicyDigest, input.hash, "uncertain readback does not undo an applied mutation");
      assert.deepEqual(printed, []);
    }, (path, value) => {
      if (path !== "projects:status" || ++statuses !== 2) return value;
      const status = value as { project: Record<string, Value> };
      return { ...status, project: { ...status.project, capturePolicyDigest: "0".repeat(64) } };
    });
  } finally { console.log = log; await rm(f.directory, { recursive: true, force: true }); }
});

// Rule rows are synthetic proposed-memory fixtures; this slice exercises approval, not recording a live run.
async function ruleInput(f: Fixture) {
  const data = { kind: "rule" as const, content: "Prefer source-backed reuse \u001b[31m", sources: [{ taskId: "source_task", revision: "exact-source-revision", evidenceRef: "fixture-evidence" }], applicability: ["src"], confidence: "reviewed" };
  const hash = await auth.digest(auth.canonical(data));
  await f.backend.context().db.insert("memories", { ...data, id: "rule", projectId: "project", revision: 1, hash, status: "proposed" });
  return { hash, argv: ["rule", "rule", "--plan", f.planPath, "--vault", f.vault, "--revision", "1", "--hash", hash], target: { memoryId: "rule", revision: 1, hash }, phrase: `approve rule project rule 1 ${hash}` };
}

test("rule approval displays exact provenance and preserves vault/plan; retries retain their recorded approver and policy version", async () => {
  const f = await fixture(), input = await ruleInput(f), before = f.backend.find("projects", "project"), vault = await readFile(f.vault), plan = await readFile(f.planPath);
  const printed: string[] = [], log = console.log;
  console.log = (...values: unknown[]) => { printed.push(values.map(String).join(" ")); };
  try {
    await wire(f, async calls => {
      const terminal = operator(input.phrase), prompt = terminal.io.prompt;
      terminal.io.prompt = async (label, hidden) => {
        if (!hidden) {
          const shown = terminal.shown.join("");
          for (const expected of [input.hash, "exact-source-revision", "fixture-evidence", '"applicability"', '"confidence"', "mandatory"]) assert(shown.includes(expected));
          assert(!shown.includes("\u001b"));
        }
        return prompt(label, hidden);
      };
      await approveCommand(input.argv, terminal.io);
      const stored = f.backend.find("memories", "rule"), project = f.backend.find("projects", "project");
      const result = { memoryId: "rule", revision: 1, hash: input.hash, status: "active", approvedBy: stored.approvedBy, policyVersion: stored.policyVersion, mutated: true };
      assert.deepEqual(JSON.parse(printed.at(-1)!), result);
      assert.equal(stored.approvedBy, "human"); assert.equal(stored.approvedHash, input.hash);
      assert.equal(project.policyVersion, before.policyVersion + 1); assert.equal(project.configVersion, before.configVersion);
      const mutation = calls.find(call => call.path === "memories:approveRule")!;
      assert.deepEqual({ memoryId: mutation.args.memoryId, revision: mutation.args.revision, hash: mutation.args.hash }, input.target);
      const replay = operator(input.phrase);
      await approveCommand(input.argv, replay.io);
      assert.deepEqual(JSON.parse(printed.at(-1)!), { ...result, mutated: false });
      assert.deepEqual(replay.asked.map(ask => ask.hidden), [true]);
      assert.equal(calls.filter(call => call.path === "memories:approveRule").length, 1);
      const owner = await openOperatorSession({ plan: f.planPath, vault: f.vault }, terminal.io), count = printed.length;
      await assert.rejects(approveRule({ ...owner, plan: { ...owner.plan, humanId: "other-human" } }, input.target), error => (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT");
      assert.equal(printed.length, count); assert.equal(calls.filter(call => call.path === "memories:approveRule").length, 1);
      assert.deepEqual(await readFile(f.vault), vault); assert.deepEqual(await readFile(f.planPath), plan);
      for (const value of [...printed, ...terminal.shown, ...terminal.asked.map(ask => ask.label)]) assert(!value.includes(f.bundle.humanToken) && !value.includes(f.bundle.agentToken) && !value.includes(passphrase));
    });
  } finally { console.log = log; await rm(f.directory, { recursive: true, force: true }); }
});

test("wrong rule revision/hash, altered content and declined confirmation never approve", async () => {
  const f = await fixture(), input = await ruleInput(f);
  try {
    await wire(f, async calls => {
      const terminal = operator(input.phrase);
      for (const argv of [input.argv.map((value, index) => index === 7 ? "2" : value), [...input.argv.slice(0, -1), "0".repeat(64)]]) {
        await assert.rejects(approveCommand(argv, terminal.io), /do not bind this exact rule/);
      }
      const row = f.backend.find("memories", "rule");
      await f.backend.context().db.patch(row._id, { content: "Changed after hashing" });
      await assert.rejects(approveCommand(input.argv, terminal.io), /do not bind this exact rule/);
      assert.deepEqual(terminal.shown, []); assert(terminal.asked.every(ask => ask.hidden));
      await f.backend.context().db.patch(row._id, { content: row.content });
      await assert.rejects(approveCommand(input.argv, operator("no").io), /confirmation did not match/);
      assert.equal(calls.filter(call => call.path === "memories:approveRule").length, 0);
      assert.equal(f.backend.find("memories", "rule").status, "proposed");
    });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("nonhuman credentials cannot read rules for approval or approve them and errors withhold credentials", async () => {
  const f = await fixture(), input = await ruleInput(f);
  try {
    await wire(f, async calls => {
      const client = new BackendClient(f.plan.config, f.bundle.agentToken), terminal = operator(input.phrase);
      const session: OperatorSession = { plan: f.plan, client, status: {}, write: terminal.io.write, prompt: terminal.io.prompt };
      await assert.rejects(approveRule(session, input.target), error => {
        assert.equal((error as { code?: string }).code, "FORBIDDEN");
        assert(!String(error).includes(f.bundle.agentToken) && !String(error).includes(f.bundle.humanToken)); return true;
      });
      await assert.rejects(f.backend.call(memories.approveRule, { ...request(f.bundle.agentToken), ...input.target }), error => (error as { data?: { code?: string } }).data?.code === "FORBIDDEN");
      assert.equal(calls.filter(call => call.path === "memories:approveRule").length, 0); assert.deepEqual(terminal.shown, []);
      assert.equal(f.backend.find("memories", "rule").status, "proposed");
    });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("a changed proposed rule and an oversized complete rule set fail without promotion or policy-version churn", async () => {
  const f = await fixture(), input = await ruleInput(f), before = f.backend.find("projects", "project");
  try {
    await wire(f, async calls => {
      const terminal = operator(input.phrase), prompt = terminal.io.prompt, row = f.backend.find("memories", "rule");
      terminal.io.prompt = async (label, hidden) => {
        if (!hidden) await f.backend.context().db.patch(row._id, { revision: 2 });
        return prompt(label, hidden);
      };
      await assert.rejects(approveCommand(input.argv, terminal.io), error => (error as { code?: string }).code === "FORBIDDEN");
      assert.equal(f.backend.find("memories", "rule").status, "proposed");
      await f.backend.context().db.patch(row._id, { revision: 1 });
      for (let index = 0; index < 3; index++) {
        const { _id: _id, _creationTime: _created, ...data } = row;
        const large = { kind: data.kind, content: "x".repeat(4096), sources: data.sources, applicability: data.applicability, confidence: data.confidence }, hash = captureDigest(large);
        await f.backend.context().db.insert("memories", { ...data, ...large, id: `large_${index}`, hash, status: "active", approvedBy: "human", approvedHash: hash, policyVersion: 1 });
      }
      await assert.rejects(approveCommand(input.argv, operator(input.phrase).io), error => (error as { code?: string }).code === "COVERAGE_INCOMPLETE");
      assert.equal(calls.filter(call => call.path === "memories:approveRule").length, 2);
      assert.equal(f.backend.find("memories", "rule").status, "proposed"); assert.deepEqual(f.backend.find("projects", "project"), before);
    });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("an applied rule approval with incomplete reply or conflicting readback prints no success", async () => {
  const printed: string[] = [], log = console.log;
  console.log = (...values: unknown[]) => { printed.push(values.map(String).join(" ")); };
  try {
    for (const corrupt of ["reply", "readback"]) {
      const f = await fixture(), input = await ruleInput(f);
      try {
        await wire(f, async () => {
          const before = printed.length;
          await assert.rejects(approveCommand(input.argv, operator(input.phrase).io), error => ["BLOCKED_ENV", "IDEMPOTENCY_CONFLICT"].includes((error as { code: string }).code));
          assert.equal(printed.length, before);
          assert.equal(f.backend.find("memories", "rule").status, "active", "an uncertain response does not undo an applied approval");
        }, (path, value) => {
          if (corrupt === "reply" && path === "memories:approveRule") {
            const { approvedBy: _approvedBy, ...rest } = value as Record<string, Value>; return rest;
          }
          if (corrupt === "readback" && path === "memories:ruleForApproval") {
            const result = value as { rule: Record<string, Value> };
            if (result.rule.status === "active") return { ...result, rule: { ...result.rule, approvedBy: "other-human" } };
          }
          return value;
        });
      } finally { await rm(f.directory, { recursive: true, force: true }); }
    }
  } finally { console.log = log; }
});

test("protected CLI approves repository-source rules and refuses malformed or foreign provenance", async () => {
  const f = await fixture();
  const source = { kind: "repository" as const, repository: f.plan.config.repository, revision: "b".repeat(40), path: "src/app.ts", contentHash: "a".repeat(64) };
  const data = { kind: "rule" as const, content: "Preserve the existing task control during completion updates.", sources: [source], applicability: ["src"], confidence: "source reviewed" };
  const rowId = await f.backend.context().db.insert("memories", { ...data, id: "repo_rule", projectId: "project", revision: 1, hash: captureDigest(data), status: "proposed" });
  try {
    await wire(f, async calls => {
      const session = await openOperatorSession({ plan: f.planPath, vault: f.vault }, operator("").io);
      for (const corrupt of [{ repository: "github.com/foreign/project" }, { revision: "main" }, { path: "../outside" }, { contentHash: "not-a-hash" }]) {
        const changed = { ...data, sources: [{ ...source, ...corrupt }] }, hash = captureDigest(changed);
        await f.backend.context().db.patch(rowId, { sources: changed.sources, hash });
        await assert.rejects(approveRule(session, { memoryId: "repo_rule", revision: 1, hash }), /unreadable rule record/);
      }
      assert.equal(calls.filter(call => call.path === "memories:approveRule").length, 0);
      const hash = captureDigest(data), terminal = operator(`approve rule project repo_rule 1 ${hash}`);
      await f.backend.context().db.patch(rowId, { sources: data.sources, hash });
      const approved = await approveRule({ ...session, ...terminal.io }, { memoryId: "repo_rule", revision: 1, hash });
      assert.equal(approved.status, "active"); assert.equal(approved.hash, hash);
      assert(terminal.shown.join("").includes(source.path)); assert(terminal.shown.join("").includes(source.contentHash));
      assert.equal(calls.filter(call => call.path === "memories:approveRule").length, 1);
    });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
