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

## Initial catalog

The repository currently includes Oho-published connection packages and three
installable development examples: Home Assistant (remote MCP), Meeting Notes
(Skill and commands), and Developer Toolkit (local Node Tools). The other twelve
entries currently declare planned connections and are not installable.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the current manual contribution flow.
