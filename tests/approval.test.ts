import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convexToJson } from "convex/values";
import type { Value } from "convex/values";
import { BackendFixture } from "./backend.fixture.js";
import * as auth from "../convex/auth.js";
import * as goals from "../convex/goals.js";
import * as projects from "../convex/projects.js";
import { bootstrapArguments, createBundle, parseSetupPlan } from "../src/onboarding.js";
import { approveCommand, approveGoal, openOperatorSession } from "../src/approval.js";
import type { OperatorSession } from "../src/approval.js";
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

const handlers: Record<string, typeof auth.handshake> = { "auth:handshake": auth.handshake, "projects:status": projects.status as unknown as typeof auth.handshake, "goals:approve": goals.approve as unknown as typeof auth.handshake };
async function wire(f: Fixture, run: (calls: Array<{ path: string; args: Record<string, unknown> }>) => Promise<void>): Promise<void> {
  const original = globalThis.fetch, calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).origin, f.plan.config.backendUrl);
    const body = JSON.parse(String(init?.body)) as { path: string; args: Array<Record<string, unknown>> }, args = body.args[0]!;
    calls.push({ path: body.path, args });
    const handler = handlers[body.path];
    assert(handler, "Only expected approval endpoints may be called");
    try { return new Response(JSON.stringify({ status: "success", value: convexToJson(await f.backend.call(handler, args as never) as Value), logLines: [] })); }
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

test("an owner approval binds the exact displayed revision and hash through one protected confirmation", async () => {
  const f = await fixture();
  const printed: string[] = [], log = console.log;
  console.log = (...values: unknown[]) => { printed.push(values.map(String).join(" ")); };
  try {
    await wire(f, async calls => {
      const terminal = operator(phrase(f));
      await approveCommand(["goal", "goal", "--plan", f.planPath, "--vault", f.vault, "--revision", String(f.draft.revision), "--hash", f.draft.hash], terminal.io);
      const mutations = calls.filter(call => call.path === "goals:approve");
      assert.equal(mutations.length, 1);
      assert.deepEqual({ goalId: mutations[0]!.args.goalId, revision: mutations[0]!.args.revision, hash: mutations[0]!.args.hash }, { goalId: "goal", revision: f.draft.revision, hash: f.draft.hash });
      assert.deepEqual(JSON.parse(printed.at(-1)!), { goalId: "goal", revision: f.draft.revision, hash: f.draft.hash, state: "active", approvedBy: f.plan.humanId, mutated: true });
      const stored = f.backend.find("goals", "goal");
      assert.equal(stored.state, "active"); assert.equal(stored.approvedHash, f.draft.hash); assert.equal(stored.approvedBy, "human");
      assert.deepEqual(terminal.asked.map(ask => ask.hidden), [true, false]);
      const display = terminal.shown.join("");
      assert(display.includes(f.draft.hash) && display.includes(`revision ${f.draft.revision}`));
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
      // A lost reply: the same operator reruns the same command, reads back the bound approval with its approver, and mutates nothing.
      const replay = operator(phrase(f));
      await approveCommand(argv, replay.io);
      assert.deepEqual(JSON.parse(printed.at(-1)!), { goalId: "goal", revision: f.draft.revision, hash: f.draft.hash, state: "active", approvedBy: f.plan.humanId, mutated: false });
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
      assert.equal(stored.state, "active"); assert.equal(stored.approvedBy, f.plan.humanId);
    });
  } finally { console.log = log; await rm(f.directory, { recursive: true, force: true }); }
});
