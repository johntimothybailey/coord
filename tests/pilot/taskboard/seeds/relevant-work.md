# Fixture source data: task input validation

Synthetic prior-work discovery seed, intended for later explicit import into the pilot backend. This document carries no approval or execution authority.

- Candidate applicability: `store.js`, `server.js`, future due-date validation.
- Available local source: `createTaskStore` in `store.js` validates task titles and completion values; `test/store.test.js` exercises state and invalid input.
- Publication state: this seed does not establish a remote ref, merged commit or checkpoint. The importing workflow must bind the actual committed revision and verify code availability.
- Suggested reuse question: can a due-date task extend the existing input boundary rather than add a second task store?
- Suggested runner evidence: execute `npm run check` at the exact candidate revision. A statement in this seed is not runner evidence.
