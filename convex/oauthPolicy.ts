import { OAUTH_SCOPE_NAMES } from "../src/oauth-scopes.js";
// Closed server-selected operation map. Scopes only restrict existing role gates.
// The full eight-scope policy is unchanged; the narrower Connect consent profile
// in src/oauth-scopes.ts bounds only what Connect offers and newly consents.
export const OAUTH_SCOPES = OAUTH_SCOPE_NAMES;
export const CONNECTION_CAP_MS = 24 * 3600_000;
export const MAX_ANCESTORS = 8;
const groups: Record<string, readonly string[]> = {
  "coord:read": ["auth.handshake", "approvalRequests.get", "checkpoints.getInput", "checkpoints.getReady", "machines.runtime", "memories.projectRules", "memories.reviewList", "memories.reviewDetail", "projects.status"],
  "coord:propose": ["goals.propose", "memories.proposeRule", "tasks.propose"],
  "coord:approval-request": ["approvalRequests.requestRule", "approvalRequests.cancel"],
  "coord:run": ["tasks.claim", "tasks.claimReplan", "tasks.registerManual", "tasks.renew", "tasks.reportClient", "tasks.sessionStatus", "tasks.checkIn", "tasks.progress", "tasks.proposeSubtasks", "tasks.refreshDependencies", "tasks.finishReplan", "tasks.requestResume", "lifecycle.starting", "lifecycle.requestFinalization", "lifecycle.requestYield", "memories.record", "memories.rules", "memories.context", "memories.expand"],
  "coord:supervise": ["lifecycle.status", "lifecycle.authorizeLaunch", "lifecycle.reportUncertain", "lifecycle.confirmStopped"],
  "coord:artifact": ["checkpoints.prepare", "publications.request", "scans.upload"],
  "coord:verify": ["checkpoints.verifyCode", "checkpoints.ready", "publications.verifyBranch", "publications.verifyPR", "publications.accept", "scans.verify"],
  "coord:message": ["messages.send", "messages.read", "messages.receipt", "messages.resolve", "messages.expand"],
};
export function operationScope(operation: string | undefined, role: string): string | undefined {
  if (operation === "checkpoints.authority") return role === "run" ? "coord:artifact" : role === "artifact_verifier" ? "coord:verify" : undefined;
  return Object.entries(groups).find(([, operations]) => operation !== undefined && operations.includes(operation))?.[0];
}
