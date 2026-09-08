# Connector migration

The source is the Oho commit immediately before `1337098` (`1337098^`). That change removed core connectors without moving their executable implementations into this registry. This migration restores the 12 provider packages and their 55 handlers.

| Plugin | Implementations | Read tools available through the bridge | Writes awaiting approval-host integration |
| --- | --- | --- | --- |
| GitHub | 15 | 15 | 0 |
| Gmail | 7 | 5 | 2 |
| Slack | 5 | 4 | 1 |
| Notion | 4 | 4 | 0 |
| 飞书 | 2 | 2 | 0 |
| Lark | 2 | 2 | 0 |
| Google Calendar | 4 | 4 | 0 |
| Google Drive | 3 | 3 | 0 |
| Google Sheets | 3 | 3 | 0 |
| Linear | 6 | 6 | 0 |
| Stripe | 3 | 3 | 0 |
| Resend | 1 | 0 | 1 |

Provider clients and handlers now live under `plugins/oho/<id>/src`. Google Workspace and Feishu/Lark share provider-family code under `providers/`; each plugin has its own entry point and manifest. `runtime/` contains the dependency-injection contracts, credential-bound operation adapters and MCP bridge. No Oho database, global connector service, environment configuration or server package is imported.

The original OAuth drivers, provider input limits, private-repository guard, paging bounds, rate-limit and error classification, timeout/cancellation signals and private audit projections are preserved. OAuth client configuration is injected by a host. The standalone bridge accepts an existing access token; it does not provide interactive OAuth login or automatic refresh.

Gmail draft writes, Gmail send proposals, Slack send proposals and Resend send proposals retain their handlers. The standalone bridge rejects all four before calling a provider. Send handlers require an injected durable `ProposalService`; there is deliberately no default direct-send fallback. The old Oho proposal database service is not copied into this independent repository. Durable approval, idempotent resume and credential-rotation validation remain host integration work.

Catalog generation imports the real handlers and never resolves credentials or calls providers. `pnpm catalog:check` detects catalog drift. MCP discovery uses those same handler schemas; Oho validates discovery against the committed catalog before installing a lock.

Tests use fixture credentials and mocked provider responses. They verify discovery for every plugin, a GitHub handler-to-client read, provider isolation, authorization failure, expired credentials, argument validation and blocked writes. They do not establish live OAuth or provider-account availability.
