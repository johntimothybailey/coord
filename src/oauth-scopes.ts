/** Shared OAuth scope names and the Connect consent profile, used by the backend
 *  policy, the protected owner CLI and the browser so one definition governs every
 *  surface. The backend policy keeps all eight scope names and their operation map;
 *  the narrower Connect profile bounds only what Connect advertises, what an owner
 *  may select in a link plan, and what a NEW project consent may contain. */
export const OAUTH_SCOPE_NAMES = ["coord:read", "coord:propose", "coord:approval-request", "coord:run", "coord:supervise", "coord:artifact", "coord:verify", "coord:message"] as const;

/** Connect's baseline: every connection needs it to verify actual project access. */
export const CONNECT_BASELINE_SCOPE = "coord:read";
/** Added only when that workflow is chosen; never implied by the baseline. */
export const CONNECT_WORKFLOW_SCOPES = ["coord:propose", "coord:approval-request"] as const;
/** Canonical order of everything Connect offers. The five execution/delegation
 *  scopes are deliberately absent: they have no delivered Connect workflow. */
export const CONNECT_OFFERED_SCOPES = [CONNECT_BASELINE_SCOPE, ...CONNECT_WORKFLOW_SCOPES] as const;

/** Human-facing purpose of each offered permission, for the owner review and the
 *  protected browser. Each one names its workflow and its limit. */
export const CONNECT_SCOPE_PURPOSE: Record<string, string> = {
  "coord:read": "Read this project's status, approved rules and the guidance offered for review. Connect always needs this to verify actual project access.",
  "coord:propose": "Propose source-backed rules for this project. Choose this only for a proposal workflow; a proposal approves nothing by itself.",
  "coord:approval-request": "Route an exact rule revision to a human for a protected passkey decision, and withdraw that request. Choose this only when routing for a human decision; it can never make the decision.",
};

export const CONNECT_OFFER_SUMMARY = "Connect offers project read, and adds rule proposal or human approval routing only when that workflow is chosen. It does not offer execution, supervision, artifact, verification or messaging permissions.";

/** The exact supported combinations: read alone, read plus one chosen workflow, or
 *  read plus both. Anything else is unsupported and is refused, never clamped.
 *  Returns the selection in canonical order so a receipt is comparable. */
export function connectConsentSelection(scopes: readonly unknown[]): string[] | undefined {
  if (!scopes.length || new Set(scopes).size !== scopes.length) return undefined;
  if (scopes.some(scope => typeof scope !== "string" || !(CONNECT_OFFERED_SCOPES as readonly string[]).includes(scope))) return undefined;
  if (!scopes.includes(CONNECT_BASELINE_SCOPE)) return undefined;
  return CONNECT_OFFERED_SCOPES.filter(scope => scopes.includes(scope));
}

/** Narrow an already-authorized wider set to exactly what Connect offers, keeping
 *  canonical order. Used where a grant or link may legitimately be wider than the
 *  Connect offer: new Connect consent is limited, existing records are never rewritten. */
export function connectOfferedSubset(scopes: readonly string[]): string[] {
  return CONNECT_OFFERED_SCOPES.filter(scope => scopes.includes(scope));
}

/** Scopes present in a request that Connect does not offer, for explicit disclosure. */
export function connectExcludedScopes(scopes: readonly string[]): string[] {
  return OAUTH_SCOPE_NAMES.filter(scope => scopes.includes(scope) && !(CONNECT_OFFERED_SCOPES as readonly string[]).includes(scope));
}
