# Contributing a plugin

The registry is intentionally simple during the alpha. A directory present in
this repository is eligible to appear in the Oho Plugin Center. Hosted
publishing, signing, automated review, and production runtime installation are
not implemented yet;
the current CLI only validates identity and copies a reviewed entry into a local
registry checkout.

## Add a plugin

1. Sign in with `oho login`.
2. Enter an empty project directory and run `oho plugin create`. The CLI fills
   the stable publisher ID and current display name from the Oho account.
3. Develop and test the plugin locally with `oho plugin dev`.
4. Prepare the registry entry with `oho plugin publish`. During the alpha,
   registry maintainers set `OHO_PLUGIN_REGISTRY_PATH` to their checkout once.
   Publishing asks the server to verify that the current account owns the
   manifest publisher ID.
5. Keep the manifest name `oho.plugin.json` and its `id` equal to the directory
   name.
6. Do not include credentials, `.env` files, tokens, build caches, or
   `node_modules`.
7. Open a pull request showing the catalog card and detail page produced by the
   manifest.

The current Oho catalog reader treats every entry as untrusted metadata. It
does not import Node runtimes or connect to MCP servers while listing plugins.
