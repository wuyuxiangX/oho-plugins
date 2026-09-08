# Oho Plugins

Public plugin registry for Oho. Every plugin is an independent package: the
manifest owns its stable ID, publisher, version, product copy, Skills, commands,
Tools, connections, and runtime declaration.

## Repository layout

```text
plugins/
  <publisher-id>/
    <plugin-id>/
      oho.plugin.json
```

The Oho server downloads and caches a pinned commit of this repository. Browsing
the Plugin Center reads metadata and artwork without executing plugin code.
Development hosts can install supported entries; unsigned production runtime
installation is not available.

## Develop locally

Create a standalone plugin outside the Oho application repository:

```bash
oho login
mkdir my-plugin && cd my-plugin
oho plugin create --name "My Plugin"
oho plugin dev
```

`oho plugin dev` registers the directory with the local Oho host. Changes to
`oho.plugin.json`, runtime files, Skills, and commands are picked up during
development.

`plugin create` writes the signed-in Oho user's stable ID and display name into
the manifest and creates starter artwork. The publisher ID is not chosen by
hand for ordinary community plugins.

## Prepare for the Plugin Center

Use the CLI to validate the current account against the manifest and prepare a
registry entry in this checkout:

```bash
OHO_PLUGIN_REGISTRY_PATH=/path/to/oho-plugins oho plugin publish
```

The registry path is an alpha maintainer setting. The stable project command is
`oho plugin publish`; a future hosted publisher can keep that command unchanged.

Then, from the Oho application repository, point the server at this checkout:

```bash
OHO_PLUGIN_REGISTRY_PATH=/path/to/oho-plugins pnpm dev
```

After refreshing the Plugin Center, the plugin appears under **Market**. Local
CLI registrations appear separately under **Development**.

## Catalog and runtime

The registry includes 12 migrated account integrations with 55 implemented tools,
plus Home Assistant, Meeting Notes and Developer Toolkit. The migrated MCP bridge
executes 51 reads with a configured account. Four write/send handlers remain
blocked until a host supplies durable approval and resume support.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm catalog:check
```

After editing tool schemas, run `pnpm catalog:generate` and commit the generated
manifests together with the implementation. Oho consumes the pinned manifest
revision and compares it with MCP discovery at installation time.

See [runtime setup](docs/runtime.md) and [migration coverage](docs/migration.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) for the current manual contribution flow.
