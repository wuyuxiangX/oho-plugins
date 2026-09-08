# Home Assistant Pack for Oho

This Pack is intentionally independent from the Oho repository. During local
development, Oho loads `oho.plugin.json` from this directory and connects to the
developer's own Home Assistant instance through its MCP Server integration.

The reference plugin contains three kinds of contribution:

- `skills/home-state/SKILL.md` tells the Agent when and how to read live state.
- `commands/*.md` provides starter prompts shown in the plugin detail view.
- `GetLiveContext` is discovered from Home Assistant's MCP Server and registered
  as an Oho Tool.

Device-control tools remain out of the allowlist until Oho has a user-visible
approval flow and target binding. The first test is deliberately read-only.

After registering the directory with `oho mcp add`, open the Home Assistant
plugin details in Oho and try:

> 请查看我家当前公开给 Home Assistant 的设备状态，按房间或设备类型简要汇总。

Editing `oho.plugin.json`, `SKILL.md`, or a command file is picked up by the local
development host without copying this plugin into the Oho repository.

No Home Assistant URL, access token, account, or device identity belongs in
this repository.
