# Fixture source data: preserve focus when completing tasks

Synthetic accessibility lesson seed for future explicit import. It is an observation candidate, not an approved rule or a claim that an assistive-technology test passed.

When a task checkbox changes, preserve that native control and update its checked state and text styling. Rebuilding the entire list can discard keyboard focus. Give the new-task field a native label and announce completed requests through the live status region.

Candidate applicability: `public/app.js`, `public/index.html`, future filter controls. Local source reference: the completion handler in `public/app.js`. Bind the exact source revision during import; current publication/remote availability is unverified. Automated state tests do not prove focus or screen-reader behavior. A future real browser keyboard and assistive-technology session should record that evidence separately.
