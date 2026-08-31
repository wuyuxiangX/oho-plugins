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

The Oho Plugin Center reads this repository as catalog metadata. During the
current alpha it does not download or execute code from the registry.

## Develop locally

Create a standalone plugin outside the Oho application repository:

```bash
oho plugin create ./my-plugin --name "My Plugin"
oho plugin dev ./my-plugin
```

The second command registers the directory with the local Oho host. Changes to
`oho.plugin.json`, runtime files, Skills, and commands are picked up during
development.

## Preview in the Plugin Center

Copy the complete plugin directory into `plugins/<publisher-id>/<plugin-id>`.
Then point the Oho server at this checkout:

```bash
OHO_PLUGIN_REGISTRY_PATH=/path/to/oho-plugins pnpm dev
```

After refreshing the Plugin Center, the plugin appears under **Market**. Local
CLI registrations appear separately under **Development**.

## Initial catalog

The repository currently includes Oho-published connection packages and three
end-to-end examples: Home Assistant (remote MCP), Meeting Notes (Skill and
commands), and Developer Toolkit (local Node Tools).

See [CONTRIBUTING.md](CONTRIBUTING.md) for the current manual contribution flow.

