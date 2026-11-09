# Setup and recovery boundaries

Before enabling a host, run the actual capability checks for its installed versions and effective permissions, including cached credential helpers, native tool access, merge/deploy routes and real process-tree stop behavior. Version/help output, sign-in status and stdio fixtures do not qualify a host. The admission backend rejects incomplete, stale and configuration-mismatched evidence.

## Export

`coord export /absolute/new-file.jsonl` reads bounded pages of the selected project's records. It excludes credential, invitation and idempotency tables. The file is private and created exclusively; existing files are not overwritten. A `complete` footer marks a successful export; a failed export remains inspectable without that footer. Pagination is not a consistent multi-query database snapshot. Pause writers and use an operator-controlled native Convex backup for migration/recovery requiring a single consistent state. Do not restore an incomplete export as if it were a backup.

## Interrupted work

- Preserve `.coord-local` admission files and Git publication journals. Never commit or share their credentials.
- Reconcile the exact request/launch/publication identity. Missing PIDs, missing receipts or failed lookups do not prove an execution or PR never existed.
- Revoke stale execution authority; keep unknown launch or unconfirmed-stop holds. A supervisor can record eventual positive stop evidence for its own old run, without approving code or changing a newer epoch.
- Resume only ready matching code/context into a new worktree. Do not reset an existing directory or substitute the current default-branch tip for the recorded execution base.
- Keep source branches, orphan snapshots, review branches and PRs. No automatic destructive ref cleanup or force updates are provided.
- Empty expected-ref leases on artifact pushes implement atomic **create-only** semantics. They cannot replace an existing ref, even with a fast-forward commit.

## Upgrade and removal

Mixed-version requests are rejected when protocol, minimum client version or required capabilities are incompatible. A deployment upgrade/migration command and recovery drill are still required release work; no speculative destructive migration is implemented. Preserve versioned backups, establish writer policy, then validate the actual supported old/new clients against the chosen deployment before rollout.

Unattended-service installation/removal and protected credential storage are not yet qualified. Before removing any eventual service, stop only its positively identified process tree, settle/revoke its runs, remove only its managed plugin/hook entries and preserve work, journals and evidence. Do not delete local state to clear an uncertain launch. The existing rule-sync helper changes only approved marker blocks and never commits files or claims other checkouts were synchronized.
