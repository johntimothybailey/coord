# Coord

Private implementation of Shared Agent Coordination v2.5: a TypeScript CLI, direct stdio MCP integrations for Codex and Antigravity, and a bring-your-own Convex backend.

**Not release-qualified.** Local tests do not establish live Convex concurrency, protected human approval, credential isolation, actual supervised harness behavior or two-machine continuation. The full scope includes autonomous dispatch and both directions of portable continuation; it has not been reduced to shared memory.

## Local development

Node 24 or newer is required. Dependencies are pinned in `package-lock.json`.

```sh
npm ci --ignore-scripts
npm run check
node dist/src/cli.js doctor --json
```

Doctor exits `2` when qualification gates are blocked and still emits valid redacted JSON. It does not install plugins, invoke a paid model, create a backend or publish code. Disposable primitive checks remain labelled `fixture`.

Implemented CLI entry points include `checkpoint`, `resume`, `review`, `daemon`, `run finalize`, `run reconcile`, `doctor`, `status`, `mcp`, `hook`, `rules sync`, project-scoped `export`, and `setup inspect`. [Command workflows and supported modes](docs/commands.md) document exact usage and recovery. The protected `setup bootstrap` / `setup connect` commands are operator-only; follow the maintainer's protected onboarding procedure outside agent-controlled terminals. Backend-dependent commands require a trusted workspace association and the appropriate backend-bound agent/run credential. `COORD_SESSION_ID` identifies a participating host session; pending admission and its grant are persisted before the backend call. A persisted receipt never substitutes for current backend authority.

Do not manually synthesize human approval or qualification records to make admission pass. No `approved=true` switch, TTY check or ordinary file permission is treated as protected human participation.

## Implementation map

- `convex/`: exact approvals, scoped credentials/grants, transactional claims, scan coverage, messages/receipts, lessons/rules, checkpoint and publication acceptance, expiry, yield and bounded replanning.
- `src/checkpoint.ts`, `worktree.ts`, `environment.ts`, `review.ts`: audited portable snapshots, exact execution bases, fresh worktree allocation, effective environment checks and immutable PR publication/reconciliation.
- `src/launch.ts`, `supervisor.ts`, `launch-wrapper.ts`, `daemon.ts`, `convex/dispatch.ts`: durable lifecycle boundaries, independent watchdogs and deterministic dispatch. A model is not the scheduler. The parsed CLI and bound MCP workflows now compose these modules with durable recovery. Actual managed launch requires qualified Linux cgroup-v2 containment and protected runtime configuration; isolated verification uses an explicitly selected preinstalled Linux bubblewrap. Neither tool availability nor local fixtures qualify a host.
- `src/mcp.ts`, `hooks.ts`, `context.ts`, `rulesync.ts`, `plugins/`: direct backend coordination and bounded source-backed context. Native hooks are cooperative guardrails; actual coverage must be qualified.
- `tests/`: deterministic faults, exported backend-handler fixtures and disposable real Git/filesystem/process checks. Backend fixtures are not a Convex service.

## Continuing the release

The selected source repository is `johntimothybailey/coord` (public). Source publication has not been performed. The private pilot app is [johntimothybailey/coord-pilot-taskboard](https://github.com/johntimothybailey/coord-pilot-taskboard); its source is also retained in `tests/pilot/taskboard`.

The approved cloud development backend is deployed under `<team>/coord` as `dev/coord`: [<dev-deployment>](https://dashboard.convex.dev/t/<team>/coord/<dev-deployment>). The operator completed protected bootstrap/connect for the private pilot, and live project-agent access is verified. Host qualification and approved goals are still required before worker execution. A VM is planned for validation; its OS, harness and access are not configured yet. This Mac plus a separate VM can support the pilot if they have distinct machine identities and independently qualified execution environments. Two worktrees on this Mac are only a rehearsal.

Read [host integration](docs/hosts.md), [backend contracts](docs/backend.md), [checkpoint contracts](docs/checkpoints.md), [shared contracts](docs/contracts.md), [containment](docs/containment.md), [supervision](docs/supervision.md), [verification runtime](docs/verification-runtime.md), [host evidence](docs/doctor.md) and [setup and recovery](docs/operations.md). The specification, execution ledger and verification records are maintained by the maintainer and are not published here. A1–A7 remain mandatory. Package publication, license selection, production deployment, merge and protected approvals remain operator decisions.
