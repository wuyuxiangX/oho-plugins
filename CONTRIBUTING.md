# Contributing a plugin

The registry is intentionally simple during the alpha. A directory present in
this repository is eligible to appear in the Oho Plugin Center; publishing,
signing, automated review, and installation are not implemented yet.

## Add a plugin

1. Develop and test the plugin locally with `oho plugin dev /path/to/plugin`.
2. Choose a stable lowercase publisher ID and plugin ID.
3. Copy the complete directory to
   `plugins/<publisher-id>/<plugin-id>`.
4. Name the manifest `oho.plugin.json` and keep its `id` equal to the directory
   name.
5. Do not include credentials, `.env` files, tokens, build caches, or
   `node_modules`.
6. Open a pull request showing the catalog card and detail page produced by the
   manifest.

The current Oho catalog reader treats every entry as untrusted metadata. It
does not import Node runtimes or connect to MCP servers while listing plugins.

