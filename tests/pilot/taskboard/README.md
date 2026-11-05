# Coord pilot taskboard

A private, local fixture for exercising coordinated work on a small real application. Node.js 24 or newer is required. There are no dependencies or installation steps. License selection is undecided; this is not a public distribution.

From this directory:

```sh
npm run check
npm start
```

Open `http://127.0.0.1:4317`. `PORT=4318 npm start` selects another local port. The server always binds `127.0.0.1`; nothing is deployed. Task data lives only in memory and resets when the process restarts.

The existing fixture supports adding, listing and marking tasks complete or incomplete. The form has a native label, required input, native submit button, labelled checkboxes, visible focus indicators and a live status region. Task titles use DOM `textContent` rather than HTML interpretation. Completion updates preserve the current checkbox instead of replacing the task list. Automated tests cover store state, validation and HTTP behavior. No browser visual QA or assistive-technology session has been performed.

## Future pilot scenarios — not executed

These are scenario inputs, not evidence that Coord passed A1–A7. The pilot still needs an approved goal, trusted routing, a private repository, a configured backend, real host registration and two distinct machines. Human approval remains required for goal/rule promotion and merge/deploy decisions.

| Spec gate | Future exercise |
| --- | --- |
| A1 | A human approves an exact taskboard goal. A real manual host registers before modifying this fixture; the daemon later assigns an approved task. |
| A2 | Two tasks describe due-date validation differently. Scope and work lookup should produce a recorded shared-interface/reuse decision before either duplicates the other. |
| A3 | A fresh related task discovers and verifies this fixture's published store validation work. Unpublished local-only work must be reported as unavailable. |
| A4 | Capture an evidence-linked accessibility lesson about preserving checkbox focus. Retrieve it for a related filter task; keep the unrelated seed out. Rule promotion stays human-controlled. |
| A5 | Publish an actual taskboard PR with tests bound to the precise head and base. Human review controls merge; there is no deployment action. |
| A6 | Interrupt a due-date task with an allowed untracked test, automatically checkpoint it, take the source machine offline and continue with matching code/context on the other host. Repeat in reverse. |
| A7 | Repeat uncertain launch, interrupted publication, stale return and missing-environment cases. Preserve holds and explicit blockers; do not invent readiness. |

| Fault family | Future exercise |
| --- | --- |
| T1–T3, T20 | Try unauthorized approval, routing substitution, duplicate requests, stale grants and provider-credential access through the real host. |
| T4–T5 | Add more than 500 small source paths in a disposable branch; inject a scanner failure and a queued warning while native editing continues. Verify complete scan recovery and the actual delivery/acknowledgement path. |
| T6–T9, T18 | Include allowed untracked source, mode/symlink changes and local-only secret ancestry; interrupt safe checkpoint publication and advance the remote base. Verify exact portable trees and safe parents. |
| T10–T13, T19 | Interrupt spawn/stop/lease/finalization boundaries and exercise prerequisites under capacity limits. An accepted PR must not release a live process reservation. |
| T14–T17 | Exercise an explicitly required fixture environment key, moved test bases, oversized or hostile memory, rule target escapes and interrupted upgrade/export. |

## Unimplemented work for later tasks

- Optional due dates with validated date-only values and accessible labels.
- Filters for all, active and completed tasks, preserving keyboard focus and meaningful empty states.
- Persistence, if a later approved goal requires data to survive server restarts.

The files in `seeds/` are clearly labelled fixture source data for a future import. They are not approved instructions, actual shared-memory records, a verified handoff or proof of a completed coordination run. No human-written continuation summary is supplied in place of automatic checkpoint capture.
