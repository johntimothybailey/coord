import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { BackendClient } from "./client.js";
import { canonicalJson } from "./canonical.js";
import { captureDigest } from "./checkpoint.js";
import type { CapturePolicy } from "./checkpoint.js";
import { parseCapturePolicy } from "./command-runtime.js";
import { readSmallFile } from "./credentials.js";
import { backendFailure } from "./hooks.js";
import { inspectPlan, parseSetupPlan, promptProtected, unlockOperatorBundle, verifyProject } from "./onboarding.js";
import type { SetupPlan } from "./onboarding.js";
import { CoordError, requireHandshake } from "./protocol.js";
import type { VersionHandshake } from "./protocol.js";

export const APPROVE_USAGE = "Usage: coord approve goal <goal-id> --plan <plan.json> --vault <absolute-encrypted-vault> --revision <n> --hash <sha256-hex>";
export const RULE_APPROVE_USAGE = "Usage: coord approve rule <memory-id> --plan <plan.json> --vault <absolute-encrypted-vault> --revision <n> --hash <sha256-hex>";
export const POLICY_APPROVE_USAGE = "Usage: coord approve policy <capture-policy.json> --plan <plan.json> --vault <absolute-encrypted-vault> --hash <sha256-hex>";

/** Injected only by tests. The CLI always passes nothing, so the real separate-operator-terminal prompt applies. */
export type OperatorPrompt = (label: string, hidden: boolean) => Promise<string>;
export interface OperatorIo { prompt?: OperatorPrompt; write?: (text: string) => void }

/** An unlocked protected operator session. The owner credential stays inside the client; nothing here exposes it. */
export interface OperatorSession {
  plan: SetupPlan;
  client: BackendClient;
  status: Record<string, unknown>;
  prompt: OperatorPrompt;
  write: (text: string) => void;
}
export interface GoalApproval { goalId: string; revision: number; hash: string; state: string; approvedBy: string; approvedAt: number; mutated: boolean }
export interface RuleApproval { memoryId: string; revision: number; hash: string; status: "active"; approvedBy: string; policyVersion: number; mutated: boolean }
type RuleSource = { taskId: string; revision: string; evidenceRef: string } | { kind: "repository"; repository: string; revision: string; path: string; contentHash: string };
interface RuleView { id: string; projectId: string; kind: "rule"; revision: number; hash: string; status: string; content: string; sources: RuleSource[]; applicability: string[]; confidence: string; approvedHash?: string; approvedBy?: string; policyVersion?: number }
function validRuleSource(value: unknown, repository: string): value is RuleSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  if (source.kind === undefined) return Object.keys(source).every(key => ["taskId", "revision", "evidenceRef"].includes(key)) && [source.taskId, source.revision, source.evidenceRef].every(field => typeof field === "string" && field.length > 0);
  return source.kind === "repository" && Object.keys(source).every(key => ["kind", "repository", "revision", "path", "contentHash"].includes(key)) && source.repository === repository && typeof source.revision === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.revision) && typeof source.contentHash === "string" && /^[a-f0-9]{64}$/.test(source.contentHash) && typeof source.path === "string" && source.path.length > 0 && source.path.length <= 8192 && !source.path.startsWith("/") && !/[\\\x00-\x1f\x7f]/u.test(source.path) && source.path.split("/").every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}
export interface PolicyApproval { projectId: string; capturePolicyDigest: string; configVersion: number; policyVersion: number; mutated: boolean }
interface GoalView { id: string; projectId: string; revision: number; content: string; hash: string; state: string; taskLimit: number; runTimeoutMs: number; approvedBy?: string; approvedHash?: string; approvedAt?: number }

const stableId = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const hex64 = (value: unknown): boolean => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Every flag is required and may appear once. Secrets are never accepted here; only nonsecret selectors and digests. */
export function approvalFlags(args: string[], allowed: readonly string[], usage: string): Record<string, string> {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  if (args.length !== allowed.length * 2) throw new CoordError("INVALID_INPUT", usage);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!, value = args[index + 1]!;
    const name = flag.startsWith("--") ? flag.slice(2) : "";
    if (!allowed.includes(name) || Object.hasOwn(values, name) || !value || value.startsWith("--")) throw new CoordError("INVALID_INPUT", usage);
    values[name] = value;
  }
  return values;
}

/**
 * Shared unlock plumbing for every protected approval subcommand: read the protected plan, confirm the
 * canonical workspace, read the passphrase with hidden input, unlock the existing vault without rewriting
 * or rebinding it, and confirm the backend project is still the exact planned identity.
 */
export async function openOperatorSession(selection: { plan: string; vault: string }, io: OperatorIo = {}): Promise<OperatorSession> {
  const prompt = io.prompt ?? promptProtected;
  const write = io.write ?? ((text: string) => { process.stderr.write(text); });
  if (!isAbsolute(selection.vault)) throw new CoordError("INVALID_INPUT", "The encrypted vault must be an absolute path");
  const plan = parseSetupPlan(JSON.parse(await readSmallFile(selection.plan)));
  await inspectPlan(plan);
  // Unlock only: the vault keeps its existing binding and is never rewritten by an approval.
  const bundle = await unlockOperatorBundle(plan, selection.vault, await prompt("Vault passphrase (not cached): ", true));
  const client = new BackendClient(plan.config, bundle.humanToken);
  try {
    requireHandshake(await client.query("auth:handshake") as VersionHandshake);
    const status = await client.query("projects:status");
    if (!status || typeof status !== "object" || Array.isArray(status)) throw new CoordError("BLOCKED_ENV", "Coord backend returned an invalid project status");
    // Policy drift is a separate approval; this only refuses a rerouted or substituted project identity.
    verifyProject(plan, status, false);
    return { plan, client, status: status as Record<string, unknown>, prompt, write };
    // Never surface a raw backend error: it can carry the request credential.
  } catch (error) { throw backendFailure(error); }
}

/** Render untrusted record text so it cannot emit terminal escapes, reorder the display or forge a prompt line. */
export function displayUntrusted(value: string): string {
  return value.replace(/\r\n?/gu, "\n").split("\n")
    .map(line => `  | ${line.replace(/[\p{Cc}\p{Cf}]/gu, character => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`)}`)
    .join("\n");
}

/** The protected human interaction itself: no flag can stand in for typing the exact approval phrase. */
export async function confirmExactApproval(session: OperatorSession, phrase: string): Promise<void> {
  if (await session.prompt(`Type ${phrase} to approve exactly this: `, false) !== phrase) throw new CoordError("NEEDS_HUMAN", "Exact approval confirmation did not match");
}

const goalContentHash = (goal: GoalView): string => createHash("sha256").update(canonicalJson({ content: goal.content, runTimeoutMs: goal.runTimeoutMs, taskLimit: goal.taskLimit })).digest("hex");

/** Approve one exact goal revision after showing the operator its content, revision and hash. */
export async function approveGoal(session: OperatorSession, target: { goalId: string; revision: number; hash: string }): Promise<GoalApproval> {
  const listed = session.status.goals;
  if (!Array.isArray(listed)) throw new CoordError("BLOCKED_ENV", "Coord backend returned no project goal listing");
  const matches = (listed as unknown[]).filter((goal): goal is GoalView => !!goal && typeof goal === "object" && (goal as GoalView).id === target.goalId);
  if (matches.length !== 1) throw new CoordError("NOT_FOUND", session.status.goalsComplete === true ? "This project has no single goal with that identity" : "The project goal listing is incomplete; this goal cannot be read exactly");
  const goal = matches[0]!;
  if (typeof goal.content !== "string" || !goal.content || !hex64(goal.hash) || typeof goal.state !== "string" || ![goal.revision, goal.taskLimit, goal.runTimeoutMs].every(Number.isSafeInteger)) throw new CoordError("BLOCKED_ENV", "Coord backend returned an unreadable goal record");
  if (goal.projectId !== session.plan.config.projectId) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Goal belongs to a different project than the protected plan");
  // The operator states the revision and hash they reviewed; a goal is never approved on the backend's word alone.
  if (goal.revision !== target.revision || goal.hash !== target.hash) throw new CoordError("GOAL_NOT_APPROVED", "The stated revision and hash are not this project's current goal revision");
  if (goalContentHash(goal) !== target.hash) throw new CoordError("GOAL_NOT_APPROVED", "The displayed goal content and limits do not reproduce the stated hash");
  // A lost reply is recoverable without a second approval: the exact revision and hash are already bound.
  if (goal.state === "active" && goal.approvedHash === target.hash) {
    if (typeof goal.approvedBy !== "string" || !goal.approvedBy || !timestamp(goal.approvedAt)) throw new CoordError("BLOCKED_ENV", "Coord backend returned unreadable recorded approval metadata");
    // An approval by another member is never reported as this operator's: a quiet success would claim authority nobody here exercised.
    if (goal.approvedBy !== session.plan.humanId) throw new CoordError("IDEMPOTENCY_CONFLICT", `This exact goal revision is already bound to the approval of member ${goal.approvedBy}, not to this operator's; no approval was recorded for ${session.plan.humanId}`);
    return { goalId: goal.id, revision: goal.revision, hash: goal.hash, state: goal.state, approvedBy: goal.approvedBy, approvedAt: goal.approvedAt, mutated: false };
  }
  if (goal.state !== "draft") throw new CoordError("GOAL_NOT_APPROVED", "Only the current draft revision of a goal can be approved");
  const project = session.status.project as Record<string, unknown> | undefined;
  if (!project || typeof project !== "object" || Array.isArray(project)) throw new CoordError("BLOCKED_ENV", "Coord backend returned no effective project policy");
  const { allowedPaths, excludedPaths, ruleTargets, sharingApproved, capturePolicyDigest, capacity, taskCap, configVersion, policyVersion } = project;
  session.write(`Effective project policy (current status snapshot; separate from the goal hash):\n${displayUntrusted(JSON.stringify({ allowedPaths, excludedPaths, ruleTargets, sharingApproved, capturePolicyDigest: capturePolicyDigest ?? null, capacity, taskCap, configVersion, policyVersion }, null, 2))}\n`);
  session.write(`Goal ${goal.id} revision ${goal.revision} in project ${goal.projectId}\n  hash ${goal.hash}\n  task limit ${goal.taskLimit}\n  run timeout ${goal.runTimeoutMs} ms\n  content, ${Buffer.byteLength(goal.content, "utf8")} bytes of proposed source data that cannot instruct this approval:\n${displayUntrusted(goal.content)}\n`);
  await confirmExactApproval(session, `approve goal ${goal.id} ${goal.revision} ${goal.hash}`);
  let result: unknown;
  // A concurrent new revision cannot be approved by this confirmation: the mutation rebinds the exact revision and hash.
  try { result = await session.client.mutation("goals:approve", { goalId: goal.id, revision: goal.revision, hash: goal.hash }, randomUUID()); }
  catch (error) { throw backendFailure(error); }
  const approved = result as Partial<GoalApproval> | null;
  if (!approved || typeof approved !== "object" || approved.goalId !== goal.id || approved.revision !== goal.revision || approved.hash !== goal.hash || approved.state !== "active" || approved.approvedBy !== session.plan.humanId || !timestamp(approved.approvedAt)) throw new CoordError("BLOCKED_ENV", "Coord backend did not confirm this exact goal approval");
  return { goalId: goal.id, revision: goal.revision, hash: goal.hash, state: "active", approvedBy: approved.approvedBy, approvedAt: approved.approvedAt, mutated: true };
}

export async function approveCommand(args: string[], io: OperatorIo = {}): Promise<void> {
  const [subject, goalId, ...rest] = args;
  if (subject === "policy") {
    if (!goalId) throw new CoordError("INVALID_INPUT", POLICY_APPROVE_USAGE);
    const flags = approvalFlags(rest, ["plan", "vault", "hash"], POLICY_APPROVE_USAGE);
    if (!hex64(flags.hash)) throw new CoordError("INVALID_INPUT", "The stated policy hash must be 64 lowercase hexadecimal characters");
    let value: unknown;
    try { value = JSON.parse(await readSmallFile(goalId)); }
    catch { throw new CoordError("INVALID_INPUT", "Capture policy must be a bounded readable JSON file; values withheld"); }
    const policy = parseCapturePolicy(value);
    if (captureDigest(policy) !== flags.hash) throw new CoordError("INVALID_INPUT", "The capture policy does not reproduce the stated hash");
    const session = await openOperatorSession({ plan: flags.plan!, vault: flags.vault! }, io);
    console.log(JSON.stringify(await approveCapturePolicy(session, policy, flags.hash!)));
    return;
  }
  const usage = subject === "rule" ? RULE_APPROVE_USAGE : APPROVE_USAGE;
  if (!["goal", "rule"].includes(subject ?? "") || !goalId || !stableId(goalId)) throw new CoordError("INVALID_INPUT", usage);
  const flags = approvalFlags(rest, ["plan", "vault", "revision", "hash"], usage);
  if (!/^(?:0|[1-9][0-9]{0,9})$/.test(flags.revision!)) throw new CoordError("INVALID_INPUT", `The stated ${subject} revision must be a nonnegative integer`);
  if (!hex64(flags.hash)) throw new CoordError("INVALID_INPUT", `The stated ${subject} hash must be 64 lowercase hexadecimal characters`);
  const session = await openOperatorSession({ plan: flags.plan!, vault: flags.vault! }, io);
  console.log(JSON.stringify(subject === "rule"
    ? await approveRule(session, { memoryId: goalId, revision: Number(flags.revision), hash: flags.hash! })
    : await approveGoal(session, { goalId, revision: Number(flags.revision), hash: flags.hash! })));
}

function projectConfiguration(session: OperatorSession, status: unknown) {
  verifyProject(session.plan, status, false);
  const project = (status as { project: Record<string, unknown> }).project;
  const { allowedPaths, excludedPaths, sharingApproved, capacity, taskCap, capturePolicyDigest } = project;
  let current: SetupPlan;
  try { current = parseSetupPlan({ ...session.plan, config: { ...session.plan.config, ruleTargets: project.ruleTargets }, policy: { allowedPaths, excludedPaths, sharingApproved, capacity, taskCap, ...(capturePolicyDigest === undefined ? {} : { capturePolicyDigest }) } }); }
  catch { throw new CoordError("BLOCKED_ENV", "Coord backend returned unreadable project policy"); }
  const configVersion = project.configVersion ?? 0, policyVersion = project.policyVersion;
  if (!timestamp(configVersion) || !timestamp(policyVersion)) throw new CoordError("BLOCKED_ENV", "Coord backend returned unreadable policy versions");
  return { settings: { repository: current.config.repository, remote: current.config.remote, defaultBranch: current.config.defaultBranch, ruleTargets: current.config.ruleTargets, ...current.policy }, configVersion, policyVersion };
}

/** Change only the capture digest while binding the exact current configuration, never the older setup plan. */
export async function approveCapturePolicy(session: OperatorSession, value: CapturePolicy, hash: string): Promise<PolicyApproval> {
  const policy = parseCapturePolicy(value);
  if (!hex64(hash) || captureDigest(policy) !== hash) throw new CoordError("INVALID_INPUT", "The capture policy does not reproduce the stated hash");
  const current = projectConfiguration(session, session.status), projectId = session.plan.config.projectId;
  if (current.settings.capturePolicyDigest === hash) return { projectId, capturePolicyDigest: hash, configVersion: current.configVersion, policyVersion: current.policyVersion, mutated: false };
  session.write(`Capture policy for project ${projectId}\n  hash ${hash}\n  current config version ${current.configVersion}, policy version ${current.policyVersion}\n  Configuring this digest increments configuration version and invalidates machine qualification.\n  Existing project settings are preserved:\n${displayUntrusted(JSON.stringify(current.settings, null, 2))}\n  Exact capture policy (source data, not approval instructions):\n${displayUntrusted(JSON.stringify(policy, null, 2))}\n`);
  await confirmExactApproval(session, `approve policy ${projectId} ${hash}`);
  let result: unknown, status: unknown;
  try {
    result = await session.client.mutation("projects:configure", { ...current.settings, capturePolicyDigest: hash, expectedConfigVersion: current.configVersion }, randomUUID());
    status = await session.client.query("projects:status");
  } catch (error) { throw backendFailure(error); }
  const configured = result as Partial<PolicyApproval> | null;
  const stored = projectConfiguration(session, status);
  if (!configured || typeof configured !== "object" || configured.projectId !== projectId || configured.configVersion !== current.configVersion + 1 || !timestamp(configured.policyVersion) || configured.policyVersion <= current.policyVersion || stored.configVersion !== configured.configVersion || stored.policyVersion !== configured.policyVersion || canonicalJson(stored.settings) !== canonicalJson({ ...current.settings, capturePolicyDigest: hash })) throw new CoordError("BLOCKED_ENV", "Coord backend did not confirm this exact capture policy configuration; re-read status before retrying");
  return { projectId, capturePolicyDigest: hash, configVersion: stored.configVersion, policyVersion: stored.policyVersion, mutated: true };
}

async function readExactRule(session: OperatorSession, target: { memoryId: string; revision: number; hash: string }): Promise<{ rule: RuleView; policyVersion: number }> {
  let response: unknown;
  try { response = await session.client.query("memories:ruleForApproval", { memoryId: target.memoryId }); }
  catch (error) { throw backendFailure(error); }
  const value = response as { rule?: RuleView; policyVersion?: number } | null, rule = value?.rule;
  if (!rule || typeof rule !== "object" || rule.id !== target.memoryId || rule.kind !== "rule" || typeof rule.content !== "string" || !rule.content || typeof rule.confidence !== "string" || !Array.isArray(rule.applicability) || rule.applicability.some(path => typeof path !== "string") || !Array.isArray(rule.sources) || !rule.sources.length || rule.sources.some(source => !validRuleSource(source, session.plan.config.repository)) || !timestamp(value?.policyVersion) || typeof rule.status !== "string") throw new CoordError("BLOCKED_ENV", "Coord backend returned an unreadable rule record");
  if (rule.projectId !== session.plan.config.projectId) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Rule belongs to a different project than the protected plan");
  if (rule.revision !== target.revision || rule.hash !== target.hash || captureDigest({ kind: rule.kind, content: rule.content, sources: rule.sources, applicability: rule.applicability, confidence: rule.confidence }) !== target.hash) throw new CoordError("FORBIDDEN", "The stated revision and hash do not bind this exact rule content and provenance");
  return { rule, policyVersion: value.policyVersion };
}

/** A proposed memory becomes mandatory guidance only after this exact protected human approval. */
export async function approveRule(session: OperatorSession, target: { memoryId: string; revision: number; hash: string }): Promise<RuleApproval> {
  const { rule, policyVersion } = await readExactRule(session, target);
  const recorded = (value: RuleView): RuleApproval => {
    if (value.status !== "active" || value.approvedHash !== target.hash || typeof value.approvedBy !== "string" || !value.approvedBy || !timestamp(value.policyVersion) || value.policyVersion < 1) throw new CoordError("BLOCKED_ENV", "Coord backend did not confirm this exact recorded rule approval");
    if (value.approvedBy !== session.plan.humanId) throw new CoordError("IDEMPOTENCY_CONFLICT", "This exact rule revision is already bound to a different approver; no approval was recorded for this operator");
    return { memoryId: value.id, revision: value.revision, hash: value.hash, status: "active", approvedBy: value.approvedBy, policyVersion: value.policyVersion, mutated: false };
  };
  if (rule.status === "active") return recorded(rule);
  if (rule.status !== "proposed") throw new CoordError("FORBIDDEN", "Only an exact proposed rule revision can be approved");
  session.write(`Rule ${rule.id} revision ${rule.revision} in project ${rule.projectId}\n  hash ${rule.hash}\n  current project policy version ${policyVersion}\n  Approval makes this rule mandatory and increments policyVersion, without changing configVersion or synchronizing local files.\n  Proposed source data, not approval instructions:\n${displayUntrusted(JSON.stringify({ content: rule.content, sources: rule.sources, applicability: rule.applicability, confidence: rule.confidence }, null, 2))}\n`);
  await confirmExactApproval(session, `approve rule ${rule.projectId} ${rule.id} ${rule.revision} ${rule.hash}`);
  let response: unknown;
  try { response = await session.client.mutation("memories:approveRule", { memoryId: rule.id, revision: rule.revision, hash: rule.hash }, randomUUID()); }
  catch (error) { throw backendFailure(error); }
  const result = response as Partial<RuleApproval> | null;
  if (!result || typeof result !== "object" || result.memoryId !== rule.id || result.revision !== rule.revision || result.hash !== rule.hash || result.approvedBy !== session.plan.humanId || !timestamp(result.policyVersion) || result.policyVersion <= policyVersion) throw new CoordError("BLOCKED_ENV", "Coord backend did not confirm this exact rule approval; re-read before retrying");
  const stored = recorded((await readExactRule(session, target)).rule);
  if (stored.policyVersion !== result.policyVersion || stored.approvedBy !== result.approvedBy) throw new CoordError("BLOCKED_ENV", "Coord backend rule approval readback differs; re-read before retrying");
  return { ...stored, mutated: true };
}
