# Pinned implementation references

Checked on November 4, 2026 against installed help and official documentation. These describe interfaces, not passing host qualification.

| Component | Pin / observed version | Primary reference |
|---|---|---|
| Node | local 24.9.0; package requires >=24 | Installed runtime and Node standard APIs |
| TypeScript | 7.0.2 | Pinned compiler; strict typecheck and NodeNext build |
| Convex | 1.49.0 | [JavaScript client](https://docs.convex.dev/client/javascript/overview), [transactions](https://docs.convex.dev/database/advanced/occ), [validation](https://docs.convex.dev/functions/validation), [runtime Web Crypto support](https://docs.convex.dev/functions/runtimes) |
| MCP SDK | @modelcontextprotocol/sdk 1.32.2 | [Official TypeScript v1 documentation](https://ts.sdk.modelcontextprotocol.io/); maintained compatibility line, not the v2 SDK |
| Zod | 4.6.7 | Required MCP SDK schema-validation peer |
| Codex | installed 0.146.0 | [Plugin packaging](https://developers.openai.com/plugins/build/plugins), [hooks](https://learn.chatgpt.com/docs/hooks), installed command help |
| Antigravity | installed agy 1.4.2 | [Plugins](https://antigravity.google/docs/build-plugins), [headless](https://antigravity.google/docs/cli/headless/), strict local plugin validator |
| GitHub | REST API version 2022-11-28 | [Pull request endpoints](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28), [gh api structured input/pagination](https://cli.github.com/manual/gh_api) |

The GitHub adapter has create/find/read operations only. It searches all PR states and pages, preserves exact repository/head/base/publication identity and passes create bodies through structured stdin. Native credential permissions remain an independently qualified boundary; an adapter's limited methods do not reduce a provider token's scopes.

Production dependency advisory check: `npm audit --omit=dev --json` returned zero reported vulnerabilities for the installed pins. This is a registry advisory lookup, not a guarantee that the application or dependencies are vulnerability-free.
