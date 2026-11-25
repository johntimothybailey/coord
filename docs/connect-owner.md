# Protected initial project linking

The routine experience is chat → protected `/connect` browser → host retry and verified status. See [the Connect runbook](connect.md). Initial project linking is a one-time deployment-owner supporting operation. Login alone creates no project access and never creates human approval authority. Approval passkeys remain separate from login passkeys.

The agent may prepare a nonsecret link plan once the human's browser displays the actual app user ID and the deployment owner has selected an existing agent credential, exact project, scope ceiling, next generation and expiry limits. The human independently compares those values in a separate protected terminal. No vault, passphrase, human token, agent token or signing key is required by these commands.

Generate a plan using actual selected values:

```text
coord connect plan --deployment <deployment-name> --backend <backend-id> --project <project-id> --user <browser-app-user-id> --source <existing-agent-id> --generation <next-generation> --scopes <comma-separated-scopes> --activation-expires-at <ISO-8601> --expires-at <ISO-8601> --out <new-absolute-plan.json>
coord connect inspect-plan <plan.json>
coord connect inspect-owner <plan.json>
coord connect link <plan.json>
```

Select permissions for the workflow this connection is for. `coord:read` is required so completion can verify actual project status; add `coord:propose` only for a proposal workflow and `coord:approval-request` only when routing an exact rule for a human decision. The supported selections are `coord:read`, `coord:read,coord:propose`, `coord:read,coord:approval-request` and all three together. Any other selection — including the execution, supervision, artifact, verification and messaging scopes — is refused with a clear message and nothing is written; the selection is never quietly reduced. `plan` and `inspect-plan` print each selected permission with what it allows, so the human confirms the exact workflow rather than a bare scope list.

The placeholders above are documentation, not a runnable operational plan. Preparing a target-specific plan with every value resolved is required before the human handoff. The `plan` operation requires `coord:read` so completion can verify actual project status. Every requested scope must be explicitly selected. It writes a new private file exclusively and generates its immutable link ID once; it does not install authority. Use a canonical filesystem path without symlinked parent directories. `inspect-plan` displays the exact public tuple and canonical SHA-256 digest without contacting the backend. `inspect-owner` is a read-only protected owner call: it shows current source/project/link history and the exact next generation. For a freshly created disposable backend with no prior identity links, generation 1 is the first candidate and the explicit bootstrap receipt supplies the existing agent source ID; neither value is invented from a name. If the inspection differs from the prepared plan, preserve the old plan and explicitly prepare a new plan only after reviewing the replacement effects. Nothing automatically increments a generation.

`link` requires the existing protected-terminal guard and official Convex owner authentication. A TTY is only an input capability check, not proof of human identity or host isolation. If the selected owner account is not signed in, the human can use the pinned local CLI in the separate terminal:

```text
node node_modules/convex/bin/main.js account login --account <prepared-owner-account> --select --login-flow auto
```

Do not have an agent perform login or paste its output into chat. Account and deployment selection must be resolved in the target-specific handoff. No `convex dev`, package upgrade or deployment is required to run the owner link operation against an already authorized deployment.

Before confirmation, the command reads the current source credential's public ID, member, role, project coverage and lifetime, the exact project repository, the authoritative highest installed generation, and the complete set of unrevoked links that this installation will revoke. It shows those fields and an exact confirmation phrase. The affected unrevoked set is complete and is displayed in full, because the human confirmation must cover every current binding the installation ends. Older generations are summarised separately as a bounded history preview; when older generations exist outside that preview the command says so explicitly. A change confined to already-revoked history outside the preview does not move the reviewed state digest. Such a change only removes authority: it cannot alter the next generation, revive a dead link or permit reassignment. Installing the next generation revokes **all prior unrevoked links for that same user/backend**, including their connections and delegated children. The backend requires the reviewed state digest and next generation to still match in the installation transaction; a concurrent change rejects the operation. This is not a generic agent-accessible internal-function dispatcher.

The official CLI receives only these public selectors, bounded scopes, timestamps and the review digest. The existing `installLink` validation and write logic remains authoritative. New identity or project membership is never inferred from a username, email, display label or model confirmation.

After a lost mutation reply, the command reads the exact immutable link ID back and compares every planned field. It claims `link_installed` only when exact current authority is verified. Keep the same plan for retries; do not generate a replacement ID or extend limits automatically. A mismatch, unavailable readback, expired plan or revoked source reports refusal or uncertainty, never success. Expired plans remain inspectable and are preserved for owner review. Readback of an existing but unusable link is explicitly not usable connection authority.

Return to `/connect`, refresh identity, compare the returned public link ID/generation and activate that exact generation. Next, the host's actual OAuth access bearer creates a short-lived exact-grant handoff. The browser reviews its effective project/scopes/cap and confirms project consent. Returning to chat and retrying `coord_finish_connect` binds the grant and reads real project status. OAuth authorization, initial link installation and browser project consent are separate states; none alone proves the host is connected.

The host must re-list or refresh its tools after completion. Some hosts cache their catalog and require reconnect/restart; automatic same-conversation refresh is not qualified. Cancellation consumes only a pending handoff and never disconnects an established connection. A cancelled or expired attempt requires a fresh OAuth grant rather than reviving its selector. Explicit disconnect is a separate browser action and revokes the selected grant.

Software fixtures cover protected confirmation, stale-state refusal and exact lost-reply readback. They do not establish real owner authentication, authenticator behavior, browser isolation, live transaction contention or native host delivery. Actual human validation remains pending until a target and deployment are separately authorized and the human performs these steps.
