# Running a migrated plugin

## Managed OAuth installation

The normal Oho install flow uses `pnpm serve:managed`. Users install a plugin and
consent in their browser; they do not configure a service URL, bridge token or
OAuth app. The service is deployed separately from Oho and hosts the provider
adapters in this repository. Oho keeps the generic user binding, encrypted token
custody, refresh lock and Agent permissions.

App credentials are **private plugin-service configuration**, not Oho environment
variables and not public manifest fields. Configure an app using a protected JSON
file containing `clientId` and, if needed, `clientSecret`:

```sh
pnpm oauth:configure gmail < /secure/google-app.json
```

The command atomically writes a new version to `~/.config/oho-plugins/oauth.json`
(mode 0600; `OHO_PLUGIN_OAUTH_CONFIG_PATH` can select a secret-mounted file).
The service reads the file for every operation. Adding or changing an app requires
**no restart of Oho or this service**. Keep old versions while their issued grants
are in use. Deploy new provider code independently of the Oho host.

Service bootstrap needs `OHO_PLUGIN_SERVICE_TOKEN` (a separate random 32+ character
host authentication secret) and `OHO_PLUGIN_REDIRECT_URI` (the Oho callback URL).
It binds loopback; use a private authenticated HTTPS reverse proxy in cloud
deployments. Never log request bodies or OAuth callback query strings.

Both launchers honor `HTTP_PROXY` / `HTTPS_PROXY` and `NO_PROXY` for outbound
provider requests. Loopback traffic stays direct. These are service-level network
settings, independent of the hot-reloaded OAuth application configuration.

OAuth adapters currently cover Gmail, Calendar, Drive, Sheets, GitHub, Slack,
Notion, Feishu and Lark. Configure only apps registered to your deployment.
Gmail managed authorization requests read-only access. Resend, Stripe and Linear
are not yet exposed through this managed OAuth entry point; the presence of their
tool implementations is not proof of a completed authorization integration.

The single-account launcher below is an advanced development option.

Oho reads catalog metadata from a pinned Git commit without starting this service.
Calling a migrated account tool requires a running MCP bridge with that account's
credentials. The bridge runs from this repository, outside the Oho server.

## Local setup

Use Node.js 22.19 or newer and pnpm 10:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Inject these environment variables through your local secret manager or process
environment. Do not put credentials in a manifest, command-line argument, tracked
file, shared shell history or logs.

| Variable | Purpose |
| --- | --- |
| `OHO_PLUGIN_PROVIDER_TOKEN` | Existing access token/API key for this plugin's account |
| `OHO_PLUGIN_MCP_TOKEN` | Separate randomly generated connection token, at least 32 characters |
| `OHO_PLUGIN_TOKEN_EXPIRES_AT` | Optional ISO timestamp; expired credentials fail closed |
| `OHO_PLUGIN_PORT` | Optional local port; omitted or `0` chooses a fresh port |

Then start a plugin, for example:

```bash
pnpm serve github
# Or use the compiled runtime:
node build/runtime/serve.js github
```

The process prints only its endpoint URL. In Oho's plugin setup, enter the base
URL (without `/mcp/github`) as **插件服务地址** and the separate bridge token as
**插件连接密钥**. The manifest supplies the endpoint path automatically. Each
process serves one plugin and one account. Run a separate process for another
account or plugin. Request arguments cannot choose credentials or provider hosts.

The supplied command binds to `127.0.0.1`, validates Host/Origin, requires bearer
authentication, bounds requests/responses, limits concurrency and request rate,
and passes timeout/cancellation signals into the provider clients. It implements
the JSON-response option of [MCP Streamable HTTP 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).
Do not expose this local bridge publicly or bind it to all network interfaces.

## Account and approval boundaries

Provider tokens stay in process memory; the bridge does not write a credential
file or log provider payloads. A deployed host must supply encrypted credential
custody, owner-scoped resolution, revocation and audit retention. The included
`ProviderService` accepts an injected credential resolver for that purpose.

OAuth provider adapters are included, with client configuration injected by the
host. The command above accepts an already authorized token; it does not provide
an OAuth callback web application or automatically refresh expired credentials.
Use the scopes declared in `runtime/provider-metadata.ts` and the provider's
least-privilege account/key configuration. GitHub reads retain the original
public-repository restriction.

The bridge exposes the complete 55-tool catalog but only executes the 51 reads.
Gmail draft writes and Gmail/Slack/Resend sends are marked **approval_required**
and rejected before provider access. Their actual handlers are migrated; send
handlers delegate to the `ProposalService` contract. A host must persist the exact
proposal revision, obtain user approval and implement idempotent resume before
enabling those operations. No approval is inferred from a tools/call request.

These are user-owned SaaS accounts: provider charges remain with that account.
No Oho AI provider usage or billing ledger is created by this bridge.

## Publishing a change

```bash
pnpm catalog:generate
pnpm catalog:check
pnpm typecheck
pnpm test
pnpm build
```

Commit source, tests, manifests and version notes together. Publish that Git
commit before pointing another environment's
`apps/server/config/plugin-registry.json` at its SHA, then run `pnpm plugins:sync`
from Oho. A local commit is not remotely fetchable until pushed; a local registry
override can be used while developing.
