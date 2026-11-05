import { randomUUID } from "node:crypto";
import { buildContext, type ContextSource } from "./context.js";
import { CoordError, DEFAULTS, type Harness, type RunIdentity } from "./protocol.js";
import type { CoordBackend, RunConnection } from "./mcp.js";

export function backendFailure(error: unknown): CoordError {
  if (error instanceof CoordError) return error;
  const data = error && typeof error === "object" && "data" in error ? error.data : undefined;
  if (data && typeof data === "object" && "code" in data && typeof data.code === "string") {
    const known = ["LEASE_REVOKED", "STALE_EPOCH", "UNAUTHORIZED", "FORBIDDEN", "CONFLICT_UNRESOLVED", "COVERAGE_INCOMPLETE", "GOAL_NOT_APPROVED", "BLOCKED_ENV", "INVALID_INPUT", "IDEMPOTENCY_CONFLICT", "UNSUPPORTED_FOR_AUTONOMOUS_EXECUTION", "CAPACITY_EXHAUSTED", "NOT_FOUND"];
    if (known.includes(data.code)) return new CoordError(data.code as CoordError["code"], `Coord backend rejected operation: ${data.code}`);
  }
  // Never return raw backend/network errors: they can contain request credentials.
  return new CoordError("BLOCKED_ENV", "Coord backend unavailable or returned an invalid response");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CoordError("BLOCKED_ENV", "Invalid backend check-in response");
  return value as Record<string, unknown>;
}

export interface CheckInOffer { text: string; messageIds: string[]; blocked: boolean }
export function renderCheckIn(value: unknown, identity: RunIdentity): CheckInOffer {
  const response = record(value), task = record(response.task), run = record(response.run);
  if (task.id !== identity.taskId || task.epoch !== identity.epoch || run.id !== identity.runId || run.epoch !== identity.epoch || run.goalRevision !== identity.goalRevision || !Array.isArray(response.messages) || typeof response.complete !== "boolean") throw new CoordError("STALE_EPOCH", "Check-in identity or coverage differs from the admitted run");
  let blocked = !response.complete || response.conflictBlocked === true;
  const sources: ContextSource[] = [{ id: "current-run", kind: "task", revision: `${identity.epoch}:${task.progressRevision}`, status: "available", text: JSON.stringify({ ...identity, state: task.state, policyVersion: response.policyVersion, complete: response.complete }) }];
  const pending: string[] = [];
  for (const item of response.messages) {
    const message = record(item);
    const requiresExpansion = message.requiresExpansion === true;
    if (typeof message.id !== "string" || (!requiresExpansion && typeof message.payload !== "string") || typeof message.conflict !== "boolean" || message.recipientTaskId !== identity.taskId || !Number.isSafeInteger(message.recipientEpoch)) throw new CoordError("BLOCKED_ENV", "Invalid backend message identity");
    if (requiresExpansion) blocked = true;
    if (message.conflict && message.resolution !== "accepted") blocked = true;
    if (message.state === "acknowledged_by_agent") continue;
    sources.push({ id: message.id, kind: "work", revision: `${identity.epoch}:${String(message.state)}`, status: "available", text: JSON.stringify({ type: message.type, payload: message.payload ?? message.payloadPreview ?? "", requiresExpansion, conflict: message.conflict, resolution: message.resolution ?? "unresolved" }) });
    if (message.recipientEpoch === identity.epoch && !requiresExpansion) pending.push(message.id);
  }
  const warning = "Coord editing/publication blocked: unresolved conflict or incomplete check-in coverage. Use Coord MCP for details.\n";
  const context = buildContext(sources, { mode: "update", maxBytes: DEFAULTS.updateBytes - Buffer.byteLength(warning, "utf8") });
  const messageIds = pending.filter(id => context.included.includes(id));
  blocked ||= context.omitted.length > 0;
  return { text: `${blocked ? warning : ""}${context.text}`, messageIds, blocked };
}

export async function fetchCheckIn(run: RunConnection): Promise<CheckInOffer> {
  return renderCheckIn(await run.client.query("tasks:checkIn", { ...run.identity }), run.identity);
}

export async function recordOffer(client: CoordBackend, identity: RunIdentity, messageIds: readonly string[]): Promise<void> {
  for (const messageId of messageIds) await client.mutation("messages:receipt", { ...identity, messageId, state: "offered_to_turn" }, randomUUID());
}

export interface HookOptions { harness: Harness; event: string; run?: RunConnection; input?: unknown }
export async function runCoordHook(options: HookOptions): Promise<Record<string, unknown>> {
  const events = options.harness === "codex" ? ["SessionStart", "PreToolUse"] : ["SessionStart", "PreInvocation", "PreToolUse"];
  if (!events.includes(options.event)) throw new CoordError("INVALID_INPUT", "Unsupported Coord hook event");
  let text = "Coord session is not registered. Use the Coord skill and register an approved task before substantive modification. Advisory reads and proposals remain available.";
  let blocked = false;
  const input = record(options.input ?? {});
  const tool = options.harness === "codex" ? input.tool_name : input.toolCall && record(input.toolCall).name;
  const nativeMutation = typeof tool !== "string" || /^(Bash|apply_patch|Edit|Write|run_command|edit_file|write_to_file|replace_file_content|multi_replace_file_content)$/.test(tool);
  if (options.run) {
    try {
      const offer = await fetchCheckIn(options.run);
      await recordOffer(options.run.client, options.run.identity, offer.messageIds);
      text = offer.text; blocked = offer.blocked;
    } catch (error) { const failure = backendFailure(error); text = `${failure.code}: ${failure.message}. Stop run-scoped edits and publication; read-only diagnostics remain available.`; blocked = true; }
  } else if (options.event === "PreToolUse") blocked = nativeMutation;
  // Keep diagnostic and conflict-resolution tools usable while disputed edits are blocked.
  const deny = blocked && nativeMutation;
  if (options.harness === "codex") return { hookSpecificOutput: { hookEventName: options.event, additionalContext: text, ...(options.event === "PreToolUse" && deny ? { permissionDecision: "deny", permissionDecisionReason: text } : {}) } };
  if (options.event === "PreToolUse") return { decision: deny ? "deny" : "allow", reason: text };
  return { injectSteps: [{ ephemeralMessage: text }] };
}
