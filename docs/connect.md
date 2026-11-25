# Connect a human account and an agent

Connect starts in the host conversation and uses a protected browser for login and exact project consent. Login passkeys identify an application user; they are separate from the existing rule-approval passkeys. Login, OAuth consent and project consent never grant human approval authority or qualify a host for task execution.

This runbook describes executable software entry points. Before live validation, explicitly select and authorize a deployment, then prepare its exact HTTPS `/connect` and `/mcp` URLs, nonsecret plans and expanded host commands. Confirm component deployment and a supported browser/authenticator before beginning. A fixture result is not a live account, authenticator, deployment or host qualification.

## Build and screen rehearsal

From a fresh checkout:

```sh
npm ci
npm run build
node --test dist/tests/connect-ui.test.js
node dist/tests/connect-ui.preview.js
```

Build explicitly resolves the already-installed, lockfile-pinned esbuild dependency of Convex; it installs nothing. The generated `convex/connectAssets.generated.ts` and `web/THIRD_PARTY_NOTICES.txt` are tracked. Build regenerates both before TypeScript compilation. Build **before** any separately authorized Convex deployment; deploying stale generated assets is not a supported workflow. The deployed page serves the bundled dependencies' notices at `/connect/third-party-notices.txt`.

The last command prints a loopback-only URL. Open that exact URL. Every screen bears **FIXTURE ONLY**. Enter a synthetic username, choose **Continue with passkey**, verify the explicit new-account confirmation, then choose **Create account with passkey**. This preview replaces both the authenticator and RPCs; it cannot sign in to a real service. Choose **Activate this project link**, **Review exact connection**, then **Authorize this exact project connection**. Expect **Project authorized; awaiting the host**, never **Connected**. Alternatively choose **Cancel pending connection** and expect the terminal cancelled state. Stop the fixture server with Ctrl-C. Do not enter real credentials in it.

## Prepare one authorized test target

The agent prepares nonsecret files and commands; the human approves the target and performs protected interactions. The target sheet must identify the deployment name, backend/project IDs, existing source agent credential ID, exact site/backend origins, selected host, scope list including `coord:read`, activation deadline and link expiry. It must also identify a disposable workspace and any preexisting registration/configuration that must be preserved.

The backend requires its real `CONVEX_SITE_URL` and `CONVEX_CLOUD_URL`. The Connect page reads those server-derived exact HTTPS origins through `/connect/config`; browser arguments cannot choose a different backend. The Auth2 relying party is the exact site hostname. The OAuth consent URL is that site's `/connect`. No external logo, script CDN or private Auth2 browser helper is used.

If the target already has an authorized test project/source agent, the sheet names that exact existing tuple. Otherwise the maintainer prepares `connect-validation/bootstrap-plan.json` for a **new disposable workspace and backend** using the existing setup plan schema. In the human's external operator terminal, from this checkout:

```sh
node dist/src/cli.js setup inspect connect-validation/bootstrap-plan.json
node dist/src/cli.js setup bootstrap connect-validation/bootstrap-plan.json "$(pwd)/connect-validation/new-test-operator.vault"
```

Inspect the canonical workspace/remote and exact plan digest. Confirm only the displayed `bootstrap <digest>` phrase for the selected disposable target; enter a new vault passphrase only in that protected terminal. Expect `bootstrap: "confirmed"`, the exact backend/project IDs, and a warning that host qualification remains blocked. Do not replace an existing workspace registry, plan or vault. `setup connect` is unnecessary merely to test browser/OAuth reads; use it only if the separately reviewed setup plan calls for a local legacy association. The agent never opens the vault or receives its passphrase.

The selected Convex owner account must have access to this deployment. The human can inspect it with `node node_modules/convex/bin/main.js login status`; if needed, run `node node_modules/convex/bin/main.js login` in the separate protected terminal and complete its browser interaction. Do not paste login links, codes or account credentials into chat. Missing target authorization, owner access, disposable plan or source credential is **BLOCKED**, not a request to seed dashboard rows or invent qualification records.

## 1. Create or sign in to the browser account

**Entry:** the maintainer supplies the selected site's exact `/connect` URL. Open it in a secure browser with your authenticator; a host webview without WebAuthn can open the same exact link in the system browser.

1. Verify the displayed deployment origin. Enter the intended username and choose **Continue with passkey**.
2. A new username changes the button to **Create account with passkey** and explicitly says the account will have no project authority. Check for typos before confirming. An existing username changes it to **Sign in with passkey**.
3. Choose that second button and complete the browser's user-verifying authenticator prompt. The agent cannot perform this step. Expect **Signed-in account** and an exact public **Application user ID**.
4. Record that public ID for the nonsecret linking plan. Do not copy session tokens, browser storage or credential responses. A brand-new user has no project access until linked.

**Cancel/retry:** dismiss the authenticator or choose **Cancel passkey prompt**. No local session or project permission is confirmed. If a finish request was already sent, it may have completed; sign in again with the same username to inspect the account. A late result cannot restore a locally cancelled/sign-out session. Unsupported browsers say no sign-in is available; they do not silently switch authentication methods.

## 2. Install and activate the exact owner link

The agent prepares one nonsecret link plan with the browser's exact public user ID. Its generation, source/backend/project, scopes and dates must be supplied by the target sheet. The preparation command has this actual shape; the maintainer supplies its expanded values, not placeholders for the human to guess:

```text
node dist/src/cli.js connect plan --deployment <selected-name> --backend <id> --project <id> --user <browser-public-user-id> --source <existing-agent-id> --generation <integer> --scopes <comma-separated-including-coord:read> --activation-expires-at <ISO-8601> --expires-at <ISO-8601> --out <new-absolute-plan.json>
```

Preparation writes a new random link ID once and reports a plan digest; it installs no authority. The supplied file is `connect-validation/link-plan.json`. In the human's external protected terminal:

```sh
node dist/src/cli.js connect inspect-plan connect-validation/link-plan.json
node dist/src/cli.js connect inspect-owner connect-validation/link-plan.json
node dist/src/cli.js connect link connect-validation/link-plan.json
```

`inspect-owner` makes a protected read-only owner call and prints the current source credential, its expiry, project and prior generations, plus the exact next generation. The link's expiry cannot exceed the existing source credential's lifetime; its activation deadline must also be in the future and no later than the link expiry. For a new disposable backend with no previous links, generation 1 is the first candidate. If inspection shows a different next generation or a shorter source lifetime, preserve the old plan and explicitly prepare a new plan with reviewed values; never automatically increment or extend it.

Independently compare the browser's **Application user ID** with the displayed plan. Check deployment, project, source, scopes, generation, dates and canonical digest. The command reads current source/project/generation state before the exact confirmation. A newer generation can revoke prior links and descendants for that user/backend; confirm only the intended replacement. It uses the official authenticated owner CLI and never reads an approval vault.

**Expected receipt:** `state: "link_installed"` with the exact plan digest, link ID, generation, user/backend/project and active state. A lost reply is reconciled against this exact tuple. On an unconfirmed outcome preserve the same plan and retry after checking owner access; do not create a replacement ID or claim rollback.

Return to `/connect`, choose **Refresh status**, and inspect **2. Project access**. Read the project/source, explained operations and UTC activation/access deadlines; expand **Exact record selectors and limits** to compare the public link ID and generation with the owner receipt. Choose **Activate this project link** for the exact pending generation. Expect that server-returned link to become active and selectable. A different browser user cannot activate it. Activation expiry or changed authority is refused; signing in again cannot resurrect an old generation.

## 3. Authorize the host's OAuth request

Use a distinct temporary host name, such as `coord-connect-validation`, without replacing an existing `coord` entry. The maintainer supplies the selected target's expanded command. For the inspected Codex CLI interface:

```text
codex mcp add coord-connect-validation --url <selected-exact-HTTPS-site>/mcp
codex mcp login coord-connect-validation --scopes coord:read --oauth-client-registration dcr
```

Add the named validation server in the human's terminal. The installed `mcp add` interface can initiate OAuth login: if it opens a browser, complete that single consent flow. Run the explicit `mcp login` command only if the new registration is not already authenticated; do not force a second consent. Use the default browser callback flow; do not copy a callback URL or authorization code into chat. Command/help support does not establish observed host login behavior. Other hosts need their own verified OAuth setup instructions and remain **UNKNOWN** until exercised; Codex CLI evidence does not qualify Orca or ChatGPT Desktop.

The host's registered OAuth request produces the exact `/connect?request=...` browser link. Sign in if necessary. Review the **Agent authorization request** summary: unverified client label, current status, described permitted operations and callback destination. Expand **Exact OAuth request details** to inspect its client ID, raw scope names and registered callback details. Client labels are text, not instructions or executable identity. The page does not invent an expiry absent from the SDK response.

Choose **Allow this agent request**, then **Return to the requesting client**. The return code stays in browser memory until navigation and is never rendered or stored. The host exchanges it. Expect OAuth authorization only: **project access is not connected yet**. Choose **Deny this agent request** instead to deny this attempt and return the denial to the host. A missing/expired request requires a fresh host request; an uncertain authorization reply does not prove denial or recover a code.

## 4. Complete exact project consent in conversation

In the host conversation, ask: **“Finish connecting Coord.”** The agent invokes `coord_finish_connect`. Before project consent, only bounded Connect onboarding tools are available; ordinary project tools cannot gain access merely from a bearer.

The tool supplies a fresh protected `/connect?handoff=...` URL for the authenticated grant. Open that exact URL, sign in as the same user, choose an active **Authorized project**, and choose **Review exact connection**. Read the prominent project/backend/source, described permitted operations and absolute UTC expiry. The relative time is only a browser-clock estimate. Expand **Exact grant, user, resource, generation and digest** to check the server-derived immutable grant/user/client/resource, link generation, raw effective scopes, original grant time, absolute ceiling and displayed digest. No UI field lets the model replace the tuple. Choose **Authorize this exact project connection** only after reviewing it.

Expect **Project authorized; awaiting the host**. Return to chat and ask **“Finish connecting Coord again, then show its current project status.”** The retry binds the existing exact consent, executes a real project status read, and reports **connected**. Choose **Refresh status** in the browser to read the same distinction. OAuth consent or a displayed handoff alone is not connected evidence.

**Cancel:** **Cancel pending connection** or chat `coord_cancel_connect` abandons only this pending attempt. It does not disconnect an established connection. Cancelled/expired attempts cannot revive; start a fresh host OAuth grant. Closing the page sends no cancellation. Read `coord_connect_status` after a lost response. The handoff's bounded lifetime never extends the original connection cap.

## 5. Check refusal, uncertainty and cleanup

| Human/agent action | Expected observable result |
| --- | --- |
| Open a handoff while signed in as a different user | Unavailable/refused; no foreign project tuple or access. |
| Review a project link belonging to another user/backend or an obsolete generation | Refused; no replacement or implicit activation. |
| Connect with only `coord:read`, then request a proposal/mutation in chat | Missing tool, insufficient scope or backend refusal; no mutation. |
| Cancel a pending attempt, then retry its old link | Cancelled terminal state; no new consent. |
| Open an expired attempt | Expired/unavailable; start a new host attempt. Never change clocks to fake qualification. |
| Lose a reply after authorize/complete/link | **Outcome uncertain**; refresh/read status for that exact ID before retrying. No rollback claim. |
| Choose **Disconnect this exact connection**, then ask for project status in chat | Selected connection is revoked; the next protected operation is refused. |
| Choose **Sign out** | Browser session is cleared locally; this is separate from disconnecting agent grants. Server sign-out can be uncertain after a network failure. |
| Refresh the host bearer during ordinary use | Existing immutable consent/cap remains; refresh grants no new project or scope. |
| Request approval of a rule | Existing separate protected approval ceremony remains mandatory. Connect login/consent cannot approve it. |

## 6. Listing scale, pagination and expiry exclusion

Project links and connections are listed per signed-in user as independently paginated sections. Neither section's volume nor failure can disable the other, so **Disconnect** stays reachable even when the link listing cannot be read.

Listing order follows each index, and the two sections differ. Connections are **newest first within your account**. Project links are ordered by the user-and-backend index, so they appear in **backend groups**, and only within one backend are they newest first. A link on a different backend can therefore sit several pages away regardless of when it was installed. Nothing in Coord guarantees that an account uses a single backend, so do not assume a globally newest-first link order; identify a link by its exact generation and backend from the expandable record details rather than by its position in the list. Each page holds five records by default; the page size is bounded by the server and a value outside its range is refused rather than clamped. The paginated query carries no time value in its index range, so a page boundary crossed after a record expires cannot invalidate the listing.

Because connections are newest first, the connection records that appear on later pages are the **oldest** ones. A browser tab opened before a deployment keeps its old JavaScript and reads a single bounded first page of up to one hundred records with no pagination controls; it degrades to that page rather than failing, and reloading the tab restores the paginated controls. Any listing refusal clears only its own section and offers a reload that re-reads page one, so a cursor whose listing is no longer trusted is never reused.

Expiry and revocation are classified for display only. A listed record is never evidence of current authority: every protected operation rechecks the exact current grant, link, membership, source and cap at fresh server time.

**Pagination walkthrough (human-executable).** With the host registered and one active project link:

1. Repeat the section 3 and section 4 sequence until **six** separate connections exist for the same browser account. Each host OAuth login produces its own grant and its own connection; do not reuse a single grant.
2. Open `/connect` and sign in. Expect **Existing project connections** to list exactly five records and show a **Show more connections** control.
3. Choose **Show more connections**. Expect the sixth and oldest record to be appended below the first five, the control to disappear, and no record to be duplicated or replaced.
4. Expand **Exact record selectors and limits** on that second-page record and record its exact connection ID as a nonsecret receipt. No owner-side command reports connection IDs, so this browser record is the authoritative selector; you will compare it again in step 6 to prove the same record was retained.
5. Choose **Disconnect this exact connection** on that second-page record. Expect a status line confirming the connection is revoked, that its record is retained as a revoked tombstone and was not deleted, and that the listing has restarted at page one. Expect the five newest records to be listed again with the revoked one no longer among them.
6. Choose **Show more connections** again and locate that same record. Expect it to be present as a revoked record with no Disconnect control, proving the tombstone was retained rather than deleted. Expand **Exact record selectors and limits** and confirm the connection ID matches the one you recorded in step 4.
7. In chat, ask the host bound to the disconnected grant for project status. Expect refusal. Ask a host bound to one of the remaining connections. Expect a normal status read.
8. Choose **Refresh status**. Expect both listings to restart from the first page with no stale cursor reused and no partially rendered list.

**Expired access and credential cleanup, without a clock change (human-executable).** This needs a separately owner-approved short-lived test link; it does not require waiting twenty-four hours and must never be done by changing a clock.

Coord's absolute deadline is an **application** cap, not revocation of the OAuth grant. When it passes, Coord refuses the connection, but the authorization server may still hold the host's grant and refresh credentials, because the installed component's refresh logic does not enforce Coord's cap. Disconnect therefore stays available on any record that has not been revoked, and it is the only way to remove that remaining grant.

1. Prepare and install a link whose `--expires-at` is only a few minutes ahead, following section 2. The connection cap is the lesser of the grant's original twenty-four hours and that link's expiry.
2. Complete a connection against it and confirm a normal project status read in chat.
3. Wait for the link expiry to pass, then choose **Refresh status**. Expect that connection to be shown as **Coord access expired**, stating that Coord already refuses it while the host's OAuth grant and refresh credentials may still exist at the authorization server. Expect **Disconnect this exact connection** to still be offered, because that grant is what remains to clean up.
4. Ask the host for project status. Expect refusal. Expect no listing, refresh or reconnect attempt to extend the original cap.
5. Choose **Disconnect this exact connection** on that expired record. Expect revocation to be confirmed, the record to become a revoked tombstone rather than disappear, and the component OAuth grant to be removed. Expect no access to be revived and no deadline to move: a disconnect after expiry is credential cleanup, never a restoration.
6. Ask the host for project status again. Expect refusal, for the same reason as before and now also because the grant is gone.

**Owner review at scale (human-executable).** Run `coord connect inspect-owner` for a prepared plan and confirm it displays the authoritative highest generation, the exact next generation, the **complete** set of unrevoked links the installation would revoke, and the bounded history preview — including its explicit statement when older generations exist outside that preview. Confirm the exact digest, then install with `coord connect link` and compare the receipt.

**Accurately classified as not human-validated by this repair.** Behaviour beyond one hundred historical connections or link generations is **software-verified / human-PENDING**. A human cannot reasonably perform one hundred and one real OAuth ceremonies or one hundred and one protected owner confirmations, and this repair seeds no live data. Separately authorized isolated test data could corroborate it later. Offline fixtures simulate index ordering and cursor sequencing; they do not establish Convex cursor validation, index behaviour, transaction contention or deployed component wiring.

For a real 24-hour-cap boundary check, record the authoritative cap and schedule a bounded soak against the approved target. Software time fixtures are not a substitute for that observation. Record only nonsecret IDs, scopes, timestamps, displayed states and authoritative receipts; do not record bearer/JWT/refresh tokens, authorization codes, passkey responses or vault credentials.

After recording the required observations, disconnect each temporary connection through the browser. Its card shows the project and recorded deadline; expand **Exact record selectors and limits** to match the exact connection ID. An unrevoked listing is registered metadata, not proof of current usable authority. Remove only the temporary host registration with `codex mcp remove coord-connect-validation`. Removal is host configuration cleanup, not proof of server revocation. Preserve uncertain receipts/plans until reconciled. Any test-account, project or deployment deletion requires separate explicit authorization.

**Completion evidence:** software checks, fixture visual checks, a target-specific expanded command sheet, and actual human/host receipts are separate. Until the selected deployment, authenticator, protected owner ceremony and host roundtrip have been exercised, live human qualification remains **PENDING**.
