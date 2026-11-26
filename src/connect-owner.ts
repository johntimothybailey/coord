import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { canonicalJson } from "./canonical.js";
import { readSmallFile, writeNewPrivateFile } from "./credentials.js";
import { promptProtected, requireProtectedTerminal } from "./onboarding.js";
import { invokeOwnerCli } from "./owner-cli.js";
import { CoordError } from "./protocol.js";
import { CONNECT_OFFERED_SCOPES, CONNECT_OFFER_SUMMARY, CONNECT_SCOPE_PURPOSE, connectConsentSelection } from "./oauth-scopes.js";
import type { OperatorIo } from "./approval.js";

export interface LinkPlan {
  schemaVersion: 1;
  deploymentName: string;
  link: { id: string; generation: number; userId: string; backendId: string; projectId: string; sourceCredentialId: string; scopes: string[]; activationExpiresAt: number; expiresAt: number };
}
const invalid = (): never => { throw new CoordError("INVALID_INPUT", "Invalid nonsecret Connect link plan; no credentials, URLs, names or extra fields are accepted"); };
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(); return value as Record<string, unknown>; }
function keys(value: Record<string, unknown>, expected: string[]) { if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) invalid(); }
export function parseLinkPlan(value: unknown): LinkPlan {
  const plan = object(value); keys(plan, ["schemaVersion", "deploymentName", "link"]);
  const link = object(plan.link); keys(link, ["id", "generation", "userId", "backendId", "projectId", "sourceCredentialId", "scopes", "activationExpiresAt", "expiresAt"]);
  if (plan.schemaVersion !== 1 || typeof plan.deploymentName !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(plan.deploymentName)) invalid();
  for (const key of ["id", "backendId", "projectId", "sourceCredentialId"]) if (typeof link[key] !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(link[key] as string)) invalid();
  if (typeof link.userId !== "string" || !/^[a-zA-Z0-9]{1,128}$/.test(link.userId) || !Number.isSafeInteger(link.generation) || Number(link.generation) < 1 || !Number.isSafeInteger(link.activationExpiresAt) || !Number.isSafeInteger(link.expiresAt) || Number(link.activationExpiresAt) <= 0 || Number(link.activationExpiresAt) > Number(link.expiresAt) || Number(link.expiresAt) <= 0 || !Number.isFinite(new Date(Number(link.activationExpiresAt)).getTime()) || !Number.isFinite(new Date(Number(link.expiresAt)).getTime()) || !Array.isArray(link.scopes)) invalid();
  // A Connect link selects one supported workflow combination: read alone, or read
  // with rule proposal and/or human approval routing. Anything else is refused here,
  // never reduced silently, so the owner confirms exactly what they chose.
  const selection = connectConsentSelection(link.scopes as unknown[]);
  if (!selection) throw new CoordError("INVALID_INPUT", `Unsupported Connect permission selection. ${CONNECT_OFFER_SUMMARY} Use --scopes with ${CONNECT_OFFERED_SCOPES[0]}, optionally adding ${CONNECT_OFFERED_SCOPES.slice(1).join(" and/or ")}.`);
  if (selection.join(",") !== (link.scopes as string[]).join(",")) invalid();
  return structuredClone(plan) as unknown as LinkPlan;
}
export const linkPlanDigest = (plan: LinkPlan): string => createHash("sha256").update(canonicalJson(plan)).digest("hex");
function safeOwnerReview(value: unknown, plan: LinkPlan) {
  const review = object(value), source = object(review.source), project = object(review.project);
  if (review.userId !== plan.link.userId || review.backendId !== plan.link.backendId || review.projectId !== plan.link.projectId || review.sourceCredentialId !== plan.link.sourceCredentialId || typeof review.userEnabled !== "boolean" || source.credentialId !== plan.link.sourceCredentialId || source.role !== "agent" || typeof source.memberId !== "string" || typeof source.documentId !== "string" || !Array.isArray(source.projectIds) || source.projectIds.some(id => typeof id !== "string" || id.length > 128) || !source.projectIds.includes(plan.link.projectId) || !Number.isFinite(source.expiresAt) || !Number.isSafeInteger(review.highestGeneration) || Number(review.highestGeneration) < 0 || typeof review.existingTruncated !== "boolean" || !Array.isArray(review.affected) || review.affected.length > 100 || !Array.isArray(review.existing) || review.existing.length > 20) invalid();
  const text = (value: unknown, max: number) => { if (typeof value !== "string" || !value || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) invalid(); return value as string; };
  const nullableTime = (value: unknown) => { if (value !== null && !Number.isFinite(value)) invalid(); return value as number | null; };
  // Array order is the server's; canonicalJson preserves it, so never re-sort here.
  const generationRow = (value: unknown) => {
    const row = object(value);
    if (!Number.isSafeInteger(row.generation) || Number(row.generation) < 1 || typeof row.active !== "boolean" || !Number.isFinite(row.expiresAt)) invalid();
    return { row, id: text(row.id, 128), generation: Number(row.generation), projectId: text(row.projectId, 128), sourceCredentialId: text(row.sourceCredentialId, 128), active: row.active as boolean, expiresAt: Number(row.expiresAt) };
  };
  // Every affected entry is unrevoked by contract, so no revokedAt field exists on it.
  const affected = (review.affected as unknown[]).map((value: unknown) => { const { row: _unused, ...link } = generationRow(value); return link; });
  const existing = (review.existing as unknown[]).map((value: unknown) => { const { row, ...link } = generationRow(value); return { ...link, revokedAt: nullableTime(row.revokedAt) }; });
  return { userId: plan.link.userId, backendId: plan.link.backendId, projectId: plan.link.projectId, sourceCredentialId: plan.link.sourceCredentialId, userEnabled: review.userEnabled, highestGeneration: Number(review.highestGeneration), source: { documentId: text(source.documentId, 128), credentialId: plan.link.sourceCredentialId, memberId: text(source.memberId, 128), role: "agent", projectIds: (source.projectIds as string[]).map(id => text(id, 128)), expiresAt: Number(source.expiresAt), revokedAt: nullableTime(source.revokedAt), lapsedAt: nullableTime(source.lapsedAt) }, project: { repository: text(project.repository, 2048), remote: text(project.remote, 2048), defaultBranch: text(project.defaultBranch, 256) }, affected, existing, existingTruncated: review.existingTruncated };
}
type OwnerReview = ReturnType<typeof safeOwnerReview>;
const isoTime = (value: number) => Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : `unavailable (${value} ms since epoch)`;
// Human review text: the complete affected unrevoked set is displayed in full because
// the confirmation must cover every current binding this installation ends.
function reviewReport(reviewed: OwnerReview, highestGeneration: number): string {
  const rows = (items: { id: string; generation: number; projectId: string; sourceCredentialId: string; active: boolean; expiresAt: number; revokedAt?: number | null }[]) =>
    items.length ? items.map(row => `  generation ${row.generation} · link ${row.id} · project ${row.projectId} · source ${row.sourceCredentialId} · ${row.active ? "activated" : "not activated"} · access ends ${isoTime(row.expiresAt)}${row.revokedAt === undefined ? "" : row.revokedAt === null ? " · unrevoked" : ` · revoked ${isoTime(row.revokedAt)}`}\n`).join("") : "  (none)\n";
  return `Authoritative highest installed generation: ${highestGeneration}\nExact next generation: ${highestGeneration + 1}\n`
    + `Complete affected unrevoked links that installing the next generation revokes (${reviewed.affected.length}; their connections and delegated children end with them):\n${rows(reviewed.affected)}`
    + `Generation history preview — at most the newest 20 generations, revoked ones included (${reviewed.existing.length}):\n${rows(reviewed.existing)}`
    + (reviewed.existingTruncated ? "Older generations exist outside this preview and are not displayed. Every unrevoked link is already listed in the complete affected set above.\n" : "");
}
function permissionReport(selected: string[]): string {
  return `Permissions this link selects (${selected.length}):\n${selected.map(scope => `  ${scope} — ${CONNECT_SCOPE_PURPOSE[scope]}\n`).join("")}${CONNECT_OFFER_SUMMARY}\n`;
}
export const CONNECT_OWNER_USAGE = "Usage: coord connect plan --deployment <name> --backend <id> --project <id> --user <public-app-user-id> --source <existing-agent-id> --generation <n> --scopes <comma-separated-scopes> --activation-expires-at <ISO-8601> --expires-at <ISO-8601> --out <new-absolute-plan.json> | connect inspect-plan|inspect-owner <plan.json> | connect link <plan.json>";
interface ConnectOwnerIo extends OperatorIo { ownerCall?: (deployment: string, operation: "connect:installOwnerLink" | "connect:inspectOwnerLink" | "connect:inspectLink", args: Record<string, unknown>) => Promise<unknown> }
export async function connectOwnerCommand(args: string[], io: ConnectOwnerIo = {}): Promise<void> {
  const [command, ...rest] = args;
  const write = io.write ?? (text => { process.stderr.write(text); });
  if (command === "plan") {
    const values = new Map<string, string>();
    const allowed = ["--deployment", "--backend", "--project", "--user", "--source", "--generation", "--scopes", "--activation-expires-at", "--expires-at", "--out"];
    for (let i = 0; i < rest.length; i += 2) {
      const flag = rest[i], value = rest[i + 1];
      if (!flag || !allowed.includes(flag) || values.has(flag) || !value || value.startsWith("--")) throw new CoordError("INVALID_INPUT", CONNECT_OWNER_USAGE);
      values.set(flag, value);
    }
    if (values.size !== allowed.length || !isAbsolute(values.get("--out")!)) throw new CoordError("INVALID_INPUT", CONNECT_OWNER_USAGE);
    const plan = parseLinkPlan({ schemaVersion: 1, deploymentName: values.get("--deployment"), link: { id: randomUUID(), generation: Number(values.get("--generation")), userId: values.get("--user"), backendId: values.get("--backend"), projectId: values.get("--project"), sourceCredentialId: values.get("--source"), scopes: values.get("--scopes")!.split(","), activationExpiresAt: Date.parse(values.get("--activation-expires-at")!), expiresAt: Date.parse(values.get("--expires-at")!) } });
    if (plan.link.activationExpiresAt <= Date.now() || plan.link.expiresAt <= Date.now()) invalid();
    await writeNewPrivateFile(values.get("--out")!, `${JSON.stringify(plan, null, 2)}\n`);
    write(`${permissionReport(plan.link.scopes)}Prepared nonsecret Connect link plan ${linkPlanDigest(plan)}. No authority was installed.\n`); return;
  }
  if (!rest[0] || rest.length !== 1 || !["inspect-plan", "inspect-owner", "link"].includes(command ?? "")) throw new CoordError("INVALID_INPUT", CONNECT_OWNER_USAGE);
  if ((command === "link" || command === "inspect-owner") && !io.prompt) requireProtectedTerminal();
  const plan = parseLinkPlan(JSON.parse(await readSmallFile(rest[0]))), hash = linkPlanDigest(plan);
  write(`${JSON.stringify(plan, null, 2)}\nActivation deadline: ${new Date(plan.link.activationExpiresAt).toISOString()} (${plan.link.activationExpiresAt} ms since epoch)\nAuthority deadline: ${new Date(plan.link.expiresAt).toISOString()} (${plan.link.expiresAt} ms since epoch)\n${permissionReport(plan.link.scopes)}Exact plan digest: ${hash}\n`);
  if (command === "inspect-plan") { write("Inspection only; no authority installed. Compare this public app user ID independently with the protected browser.\n"); return; }
  const prompt = io.prompt ?? promptProtected;
  write("One-time protected owner linking. Independently match the browser app user ID, deployment, project, existing agent, scopes and limits. This grants agent project access, never human approval authority. No vault is read.\n");
  const call = io.ownerCall ?? (async (deployment, operation, selected) => invokeOwnerCli(deployment, operation, selected));
  const inspect = async () => {
    let inspection: Record<string, unknown>;
    try { inspection = object(await call(plan.deploymentName, "connect:inspectOwnerLink", { userId: plan.link.userId, backendId: plan.link.backendId, projectId: plan.link.projectId, sourceCredentialId: plan.link.sourceCredentialId })); }
    catch { throw new CoordError("NEEDS_HUMAN", "Protected owner inspection failed. Verify the selected owner account in your separate terminal; preserve this exact plan. No installation was attempted"); }
    const reviewed = safeOwnerReview(inspection.review, plan);
    // The preview holds the newest generations, so its maximum is still authoritative.
    const highestGeneration = Math.max(0, ...reviewed.existing.map(link => link.generation));
    if (inspection.highestGeneration !== highestGeneration || reviewed.highestGeneration !== highestGeneration || typeof inspection.digest !== "string" || createHash("sha256").update(canonicalJson(reviewed)).digest("hex") !== inspection.digest) throw new CoordError("BLOCKED_ENV", "Protected owner inspection digest or generation did not match the exact safe review");
    return { reviewed, digest: inspection.digest, highestGeneration };
  };
  if (command === "inspect-owner") {
    const inspected = await inspect();
    write(`${canonicalJson({ ...inspected, nextGeneration: inspected.highestGeneration + 1, sourceExpiryIso: new Date(inspected.reviewed.source.expiresAt).toISOString() })}\n${reviewReport(inspected.reviewed, inspected.highestGeneration)}Owner inspection only. No authority was installed or changed.\n`); return;
  }
  // An exact existing installation can be verified without a second mutation.
  const readback = async (): Promise<Record<string, unknown> | null> => {
    try { const value = await call(plan.deploymentName, "connect:inspectLink", { id: plan.link.id }); return value === null ? null : object(value); } catch { return null; }
  };
  let existing = await readback();
  let stateDigest: string | undefined;
  if (!existing) {
    if (plan.link.activationExpiresAt <= Date.now() || plan.link.expiresAt <= Date.now()) throw new CoordError("NEEDS_HUMAN", "This exact plan expired and its installation is unconfirmed. Preserve it for protected owner inspection; no new mutation or automatic replacement is attempted");
    const inspected = await inspect();
    if (plan.link.generation !== inspected.highestGeneration + 1) throw new CoordError("IDEMPOTENCY_CONFLICT", `The reviewed next generation is ${inspected.highestGeneration + 1}, not this plan's generation. Nothing was installed. Use connect inspect-owner with this preserved plan before explicitly preparing a new plan`);
    const reviewed = inspected.reviewed;
    stateDigest = inspected.digest;
    write(`Current protected owner review: ${canonicalJson(reviewed)}\n${reviewReport(reviewed, inspected.highestGeneration)}Installing this generation revokes ALL prior unrevoked links for this exact user/backend, including their existing connections and children.\n`);
  } else write("An existing link with this exact ID will be read back; no replacement generation will be installed.\n");
  const phrase = `link ${plan.link.projectId} ${plan.link.userId} ${hash}${stateDigest ? ` ${stateDigest}` : ""}`;
  if (await prompt(`Type ${phrase} to authorize exactly the displayed link and replacement effects: `, false) !== phrase) throw new CoordError("NEEDS_HUMAN", "Exact Connect link confirmation did not match");
  // A lost mutation reply is reconciled with exact authoritative readback. Never
  // generate another ID or infer failure from a transport exception.
  if (!existing) { try { await call(plan.deploymentName, "connect:installOwnerLink", { ...plan.link, expectedStateDigest: stateDigest }); } catch { /* inspect exact tuple below */ } }
  let result: Record<string, unknown>;
  try { result = object(await call(plan.deploymentName, "connect:inspectLink", { id: plan.link.id })); }
  catch { throw new CoordError("NEEDS_HUMAN", "Connect link is unconfirmed. Preserve this exact plan. In your separate protected terminal, verify the selected Convex owner account and retry this same link command; do not create a replacement plan or paste authentication output into chat"); }
  const { linkId, active, eligible, lifecycle, ...tuple } = result;
  if (eligible !== true) throw new CoordError("NEEDS_HUMAN", `The exact link record exists but is ${["revoked", "expired", "activation_expired", "authority_unavailable"].includes(String(lifecycle)) ? lifecycle : "unavailable"}. Preserve this plan for protected owner inspection; usable connection authority is not confirmed`);
  if (typeof linkId !== "string" || typeof active !== "boolean" || canonicalJson(tuple) !== canonicalJson(plan.link)) throw new CoordError("BLOCKED_ENV", "Exact Connect link readback did not match. Preserve the plan for protected owner inspection; no successful installation is claimed");
  write(`${JSON.stringify({ state: "link_installed", planDigest: hash, linkId, generation: plan.link.generation, userId: plan.link.userId, backendId: plan.link.backendId, projectId: plan.link.projectId, active })}\nReturn to the protected browser, refresh identity, and activate this exact generation.\n`);
}
