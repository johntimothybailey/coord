# Host interfaces and qualification

Adapter arguments were checked against Codex CLI 0.146.x, Antigravity `agy` 1.4.x and Claude Code 2.1.x on macOS arm64. Re-verify versions on your own host; a version check is not a qualification. Adapters construct argument arrays for these actual CLIs and request sandboxing. They do not establish permission isolation or managed eligibility.

| Host | Installation interface (not executed) | MCP interface | Check-in definition |
| --- | --- | --- | --- |
| Codex | `codex plugin marketplace add PATH`; `codex plugin add coord@MARKETPLACE` | `codex mcp add coord -- coord mcp` | `hooks/hooks.json`: SessionStart and PreToolUse |
| Antigravity | `agy plugin install ./plugins/antigravity` | `agy mcp add coord coord mcp` | `hooks.json`: SessionStart, PreInvocation and PreToolUse |
| Claude Code | `claude plugin marketplace add PATH`; `claude plugin install coord@MARKETPLACE` | `.mcp.json`: `coord mcp` | `hooks/hooks.json`: SessionStart and PreToolUse |

Build the package and make its `coord` bin available on PATH before using either plugin. Its MCP entry is `coord mcp` (`node dist/src/cli.js mcp` from this checkout). Hooks use `coord hook HOST EVENT`, receiving event JSON on stdin. No credentials belong in plugin files. The Codex package uses its supported compatibility manifest; Antigravity uses its native manifest and `mcp_config.json`.

Codex plugin hooks require explicit host trust. Native hooks are guardrails with coverage limits, and Antigravity hook errors fail open. Cooperative MCP check-ins remain required when hooks are unavailable. A package manifest, validator result or returned JSON does not prove registration, turn injection, or acknowledgement. Only a tested host session may produce that evidence; actual delivery, backend registration, credential isolation, and two-machine acceptance remain BLOCKED until exercised.

Safe discovery commands run here: both hosts' `--version` and `--help`; `codex plugin --help`, `codex plugin add --help`, `codex plugin marketplace add --help`, `codex mcp add --help`, `codex exec --help`; `agy plugin --help`, `agy mcp add --help`. Antigravity documents `agy plugin validate PATH --strict --json`; `agy plugin validate --help` is rejected by version 1.4.2, so use `agy plugin --help` for that syntax. No model turn or host installation was executed.

The maintainer's redacted capability ledger separates host-command support from actual Coord discovery and delivery. `agy plugin validate ./plugins/antigravity --strict --json` passed with one skill, one MCP server, one hook group and no findings. The stdio MCP tests use the real SDK transport with a fixture backend; they do not qualify a real host or deployed backend.

## Claude Code support boundary

Claude Code is supported for **advisory** participation only. Its plugin uses the documented standard layout: the manifest at `.claude-plugin/plugin.json`, `.mcp.json` and `hooks/hooks.json` at the plugin root, and `skills/coord/SKILL.md`. `claude plugin validate ./plugins/claude` passes with no warnings. Its `PreToolUse` hook consumes `tool_name` and returns the same `hookSpecificOutput` envelope Codex uses, with `permissionDecision` and `permissionDecisionReason`; `SessionStart` injects `additionalContext` and cannot block.

Managed launch and read-only replanning are **explicitly unsupported** for this harness, and `selectedAdapter` cannot reach a Claude adapter because `claude` is deliberately absent from the runtime harness enum in `src/command-runtime.ts`. Two separate reasons, neither resolved by configuration:

- Claude Code's `--permission-mode` and allowed-tool lists are a different enforcement model from the `--sandbox workspace-write` / `--sandbox read-only` contract the Codex paths rely on. A flag rename is not a proof.
- No protected runtime startup binding has been demonstrated. The plugin registers plain advisory `coord mcp`, which by design cannot mint a manual registration or renew a run.

The backend also constrains `capabilityKey.harness` to `codex` or `antigravity` in `convex/schema.ts`, so no Claude capability key, qualified machine record or manual registration can be submitted at all. Widening that union is a schema change requiring a deployment, and it is **not** done. Until it is, `coord_register_manual` rejects `harness: "claude"` before any backend request, which is the intended fail-closed behavior rather than an oversight.

The `PreToolUse` matcher is `Bash|Edit|Write|NotebookEdit` rather than `.*`. A denial is only ever possible on a mutation tool, so matching read tools would add a subprocess and a backend round trip per read with no enforcement benefit. The deliberate consequence is that check-in context and message receipts are delivered less often than on a `.*` matcher, so T5 delivery evidence for this harness must be read against the narrower matcher and not assumed equivalent. Writes performed through `Bash` are observed, but Coord still cannot see a mutation that a tool outside this list performs.


## Protected runtime actions

Trusted startup can run `coord mcp --runtime <protected-file> --session <admitted-session>` to connect the worker's stdio tools directly to the bounded command graph. No separate IPC service is required. Startup resolves protected routing and credential locations and binds one exact run, epoch, goal revision and launch ID. Every callback revalidates that binding. The model's tool arguments cannot choose a runtime file, session, credential, shell command or attestation.

| Tool | Accepted arguments | Meaning |
| --- | --- | --- |
| `coord_checkpoint` | `checkpointId` | Request audited capture/publication through the fixed runtime. |
| `coord_review` | `checkpointId`, `publicationId` | Request or reconcile exact review publication, with backend authority checked on each attempt. |
| `coord_finalize` | `outcome`: `succeeded`, `failed` or `stopped` | Request finalization; a stale local renewal error does not bypass or prevent backend authorization. |
| `coord_finish_replan` | `result`, up to 20 dependency proposals, bounded `rationale` | Return a revised, blocked or failed result from the admitted replanning run. |
| `coord_dependency_input` | `dependencyTaskId` | Read compact metadata for the current task's exact declared dependency pin; never choose an arbitrary task or full manifest. |

The callbacks are absent in an ordinary advisory MCP connection; runtime tool calls then return an explicit configuration blocker. They expose no approval, raw backend, merge, deployment or verifier route. Successful review, finalization or replanning closes ordinary writes and local renewal. Finalization and exact review reconciliation still reach the protected helper, which decides current authority. A source-data receipt never grants permission for more work and does not prove process exit or capacity release.

Trusted startup may return a cleanup-only binding after independently validating the accepted review state. Such a restarted server begins with ordinary writes, registration, replanning and renewal closed; only protected review reconciliation and finalization callbacks remain available. A persisted receipt alone cannot choose this mode or recreate execution authority. Dependency lookup fixes the current task from its bound run and requests metadata without the private manifest. Availability and exact refs/commits/trees identify source material; they do not imply merge, automatic integration or substitution of a newer artifact.

Codex startup supplies fixed nonsecret MCP command arguments for the protected runtime/session. Qualification still requires current owner-provisioned `mcp.runtime-actions` evidence and all other applicable checks. Antigravity runtime mode remains unsupported unless its actual configured plugin path and fixed startup binding are independently proven. SDK callback fixtures and the disposable parsed-command graph exercise implementation behavior; neither is real host qualification. No paid model execution or global plugin installation is part of those tests.

Sources: [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Antigravity plugin format](https://antigravity.google/docs/build-plugins), [Antigravity hooks](https://antigravity.google/docs/hooks/), [Antigravity headless mode](https://antigravity.google/docs/cli/headless/). Consult these alongside the installed CLI help before changing arguments or manifests.

Plain `coord mcp` is advisory read/propose only; it cannot mint a manual registration or renew an execution by accepting model-supplied host qualification. Participating sessions enter through qualified resume/daemon startup and use the protected runtime bridge. Host identity and evidence are derived and revalidated by that trusted path, never asserted by tool arguments.
