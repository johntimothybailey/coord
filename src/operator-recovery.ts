import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decryptVault, encryptVault, generateToken, readSmallFile, syncLocalFile, writeNewPrivateFile } from "./credentials.js";
import { inspectPlan, parseSetupPlan, planDigest, promptProtected, requireProtectedTerminal, validateRecoveredOperatorBundle } from "./onboarding.js";
import type { RecoveredOperatorBundle, SetupPlan } from "./onboarding.js";
import { CoordError } from "./protocol.js";
import { backendFailure } from "./hooks.js";
import type { OperatorIo } from "./approval.js";

export const RECOVER_USAGE = "Usage: coord setup recover-operator <plan.json> <NEW-absolute-vault> --replace <public-old-human-credential-id> [--retry]";
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const selection = (plan: SetupPlan, replacedCredentialId: string) => ({ backendId: plan.config.backendId, projectId: plan.config.projectId, repository: plan.config.repository, remote: plan.config.remote, defaultBranch: plan.config.defaultBranch, memberId: plan.humanId, replacedCredentialId });
interface RecoveryIo extends OperatorIo { ownerCall?: (plan: SetupPlan, operation: "inspect" | "recover", args: Record<string, unknown>) => Promise<unknown> }
async function ownerCall(plan: SetupPlan, operation: "inspect" | "recover", args: Record<string, unknown>): Promise<unknown> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    // The official CLI alone handles owner authentication. Arguments contain only public selectors/digests.
    const output = execFileSync(process.execPath, [join(root, "node_modules/convex/bin/main.js"), "run", `operatorRecovery:${operation}`, JSON.stringify(args), "--deployment", plan.deploymentName, "--typecheck", "disable", "--codegen", "disable"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 128 * 1024, encoding: "utf8" });
    return JSON.parse(output) as unknown;
  } catch {
    if (operation === "inspect") throw new CoordError("NEEDS_HUMAN", "Owner inspection failed before recovery in this attempt. Authenticate the existing owner/admin account in your protected terminal, then rerun the same command unchanged. This attempt created no new vault; preserve any earlier recovery vault");
    throw new CoordError("NEEDS_HUMAN", "Owner recovery unconfirmed. Preserve the new recovery vault and retry this exact operation with --retry; never reset bootstrap or generate another token after an uncertain reply");
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CoordError("BLOCKED_ENV", "Unreadable protected recovery response");
  return value as Record<string, unknown>;
}
/** Human-only supporting recovery. The old vault is never selected, opened, decrypted or overwritten. */
export async function recoverOperatorCommand(args: string[], io: RecoveryIo = {}): Promise<void> {
  const [planPath, vaultPath, flag, oldId, retry] = args;
  if (!planPath || !vaultPath || !isAbsolute(vaultPath) || flag !== "--replace" || !oldId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(oldId) || !(args.length === 4 || args.length === 5 && retry === "--retry")) throw new CoordError("INVALID_INPUT", RECOVER_USAGE);
  if (!io.prompt) requireProtectedTerminal();
  const plan = parseSetupPlan(JSON.parse(await readSmallFile(planPath))), prompt = io.prompt ?? promptProtected, write = io.write ?? ((text: string) => { process.stderr.write(text); }), call = io.ownerCall ?? ownerCall;
  await inspectPlan(plan);
  const binding = { backendId: plan.config.backendId, backendUrl: plan.config.backendUrl, projectId: plan.config.projectId, humanId: plan.humanId };
  try {
    // Create mode refuses any pre-existing path without reading its contents, including the lost vault.
    if (!retry) {
      const exists = await lstat(vaultPath).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
      if (exists) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Recovery requires a new vault path; existing files will not be opened or overwritten. Use --retry only for this operation's newly created recovery vault");
    }
    const selected = selection(plan, oldId), inspection = object(await call(plan, "inspect", selected));
    if (Object.entries(selected).some(([key, value]) => inspection[key] !== value) || !Number.isSafeInteger(inspection.expiresAt) || typeof inspection.revoked !== "boolean" || (!retry && inspection.revoked)) throw new CoordError("BLOCKED_ENV", "Owner inspection did not confirm the exact recoverable human authority");
    if (plan.credentialExpiresAt <= Date.now() || plan.credentialExpiresAt > Date.now() + 365 * 86400_000 || (Number(inspection.expiresAt) > Date.now() && plan.credentialExpiresAt > Number(inspection.expiresAt))) throw new CoordError("FORBIDDEN", "Recovery expiry must be current and cannot extend a still-valid grant");
    write(`Protected operator recovery: ${JSON.stringify({ ...selected, expiresAt: plan.credentialExpiresAt, planDigest: planDigest(plan) })}\nThis creates replacement human authority and immediately revokes the selected old credential and its linked passkey/enrollment authority. Project policy, approvals, agent access and the existing vault stay unchanged.\n`);
    if (Number(inspection.expiresAt) <= Date.now()) write("The old grant expired. This operation explicitly reauthorizes the displayed human scope until the displayed new expiry.\n");
    const phrase = `recover operator ${plan.config.projectId} ${oldId} ${planDigest(plan)} ${plan.credentialExpiresAt}`;
    if (await prompt(`Type ${phrase} to authorize this exact recovery: `, false) !== phrase) throw new CoordError("NEEDS_HUMAN", "Exact recovery confirmation did not match");
    let bundle: RecoveredOperatorBundle, encoded: string;
    if (retry) {
      encoded = await readSmallFile(vaultPath, true);
      bundle = validateRecoveredOperatorBundle(plan, await decryptVault(encoded, await prompt("Recovery vault passphrase (not cached): ", true), binding));
      if (bundle.replacedCredentialId !== oldId) throw new CoordError("UNTRUSTED_WORKSPACE_CONFIG", "Recovery vault selects a different old credential");
    } else {
      const password = await prompt("New recovery vault passphrase (16+ UTF-8 bytes; save privately): ", true);
      if (password !== await prompt("Repeat new passphrase: ", true)) throw new CoordError("INVALID_INPUT", "Passphrases differ");
      const recoveryId = randomUUID();
      bundle = { schemaVersion: 2, purpose: "operator-recovery", planDigest: planDigest(plan), humanToken: generateToken(), recoveryId, credentialId: `recovered_${recoveryId}`, replacedCredentialId: oldId, expiresAt: plan.credentialExpiresAt };
      encoded = await encryptVault(bundle, password, binding);
      await writeNewPrivateFile(vaultPath, encoded);
    }
    // Exact retry re-establishes durable private bytes before revoking any authority remotely.
    await syncLocalFile(vaultPath, hash(encoded));
    const result = object(await call(plan, "recover", { ...selected, recoveryId: bundle.recoveryId, credentialId: bundle.credentialId, credentialDigest: hash(bundle.humanToken), expiresAt: bundle.expiresAt }));
    const expected = { recoveryId: bundle.recoveryId, credentialId: bundle.credentialId, replacedCredentialId: oldId, memberId: plan.humanId, projectId: plan.config.projectId, expiresAt: bundle.expiresAt };
    if (Object.entries(expected).some(([key, value]) => result[key] !== value) || !Number.isSafeInteger(result.recoveredAt) || Number(result.recoveredAt) <= 0 || Number(result.recoveredAt) > Date.now() + 60_000) throw new CoordError("BLOCKED_ENV", "Recovery reply unconfirmed. Preserve the recovery vault and retry the exact operation with --retry; the backend may already have applied it");
    write(`${JSON.stringify({ ...expected, recoveredAt: result.recoveredAt })}\nOperator access recovered. Keep both vault files; use only the new human-only recovery vault for protected passkey enrollment and approvals. Do not run setup bootstrap/connect with it.\n`);
  } catch (error) { throw backendFailure(error); }
}
