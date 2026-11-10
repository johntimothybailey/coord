import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { BackendClient } from "./client.js";
import { canonicalJson } from "./canonical.js";
import { readSmallFile } from "./credentials.js";
import { backendFailure } from "./hooks.js";
import { inspectPlan, parseSetupPlan, promptProtected, unlockBundle, verifyProject } from "./onboarding.js";
import type { SetupPlan } from "./onboarding.js";
import { CoordError, requireHandshake } from "./protocol.js";
import type { VersionHandshake } from "./protocol.js";

export const APPROVE_USAGE = "Usage: coord approve goal <goal-id> --plan <plan.json> --vault <absolute-encrypted-vault> --revision <n> --hash <sha256-hex>";

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
export interface GoalApproval { goalId: string; revision: number; hash: string; state: string; approvedBy: string; mutated: boolean }
interface GoalView { id: string; projectId: string; revision: number; content: string; hash: string; state: string; taskLimit: number; runTimeoutMs: number; approvedBy?: string; approvedHash?: string }

const stableId = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
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
  const bundle = await unlockBundle(plan, selection.vault, await prompt("Vault passphrase (not cached): ", true));
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
  if (goal.state === "active" && goal.approvedHash === target.hash && typeof goal.approvedBy === "string" && goal.approvedBy) {
    // An approval by another member is never reported as this operator's: a quiet success would claim authority nobody here exercised.
    if (goal.approvedBy !== session.plan.humanId) throw new CoordError("IDEMPOTENCY_CONFLICT", `This exact goal revision is already bound to the approval of member ${goal.approvedBy}, not to this operator's; no approval was recorded for ${session.plan.humanId}`);
    return { goalId: goal.id, revision: goal.revision, hash: goal.hash, state: goal.state, approvedBy: goal.approvedBy, mutated: false };
  }
  if (goal.state !== "draft") throw new CoordError("GOAL_NOT_APPROVED", "Only the current draft revision of a goal can be approved");
  session.write(`Goal ${goal.id} revision ${goal.revision} in project ${goal.projectId}\n  hash ${goal.hash}\n  task limit ${goal.taskLimit}\n  run timeout ${goal.runTimeoutMs} ms\n  content, ${Buffer.byteLength(goal.content, "utf8")} bytes of proposed source data that cannot instruct this approval:\n${displayUntrusted(goal.content)}\n`);
  await confirmExactApproval(session, `approve goal ${goal.id} ${goal.revision} ${goal.hash}`);
  let result: unknown;
  // A concurrent new revision cannot be approved by this confirmation: the mutation rebinds the exact revision and hash.
  try { result = await session.client.mutation("goals:approve", { goalId: goal.id, revision: goal.revision, hash: goal.hash }, randomUUID()); }
  catch (error) { throw backendFailure(error); }
  const approved = result as Partial<GoalApproval> | null;
  if (!approved || typeof approved !== "object" || approved.goalId !== goal.id || approved.revision !== goal.revision || approved.hash !== goal.hash || approved.state !== "active") throw new CoordError("BLOCKED_ENV", "Coord backend did not confirm this exact goal approval");
  // The backend binds the approver to the credential that carried the mutation, which is the owner identity named by this protected plan and unlocked from its vault.
  return { goalId: goal.id, revision: goal.revision, hash: goal.hash, state: "active", approvedBy: session.plan.humanId, mutated: true };
}

export async function approveCommand(args: string[], io: OperatorIo = {}): Promise<void> {
  const [subject, goalId, ...rest] = args;
  if (subject !== "goal" || !goalId || !stableId(goalId)) throw new CoordError("INVALID_INPUT", APPROVE_USAGE);
  const flags = approvalFlags(rest, ["plan", "vault", "revision", "hash"], APPROVE_USAGE);
  if (!/^(?:0|[1-9][0-9]{0,9})$/.test(flags.revision!)) throw new CoordError("INVALID_INPUT", "The stated goal revision must be a nonnegative integer");
  if (!hex64(flags.hash)) throw new CoordError("INVALID_INPUT", "The stated goal hash must be 64 lowercase hexadecimal characters");
  const session = await openOperatorSession({ plan: flags.plan!, vault: flags.vault! }, io);
  console.log(JSON.stringify(await approveGoal(session, { goalId, revision: Number(flags.revision), hash: flags.hash! })));
}
