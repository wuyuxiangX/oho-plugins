import { readFile, writeFile } from "node:fs/promises";
import { createPluginTools, pluginIds } from "../runtime/plugins.js";
import { ProviderService } from "../runtime/service.js";

const service = new ProviderService(async () => {
	throw new Error("Catalog generation must not resolve credentials");
});
for (const id of pluginIds) {
	const path = new URL(`../plugins/oho/${id}/oho.plugin.json`, import.meta.url);
	const manifest = JSON.parse(await readFile(path, "utf8"));
	const tools = createPluginTools(id, service).map(({ manifest: tool }) => {
		const { runtimeName, schemaHash, version, ...metadata } = tool;
		return {
			...metadata,
			id: runtimeName,
			defaultMode: tool.sideEffect === "none" ? "allowed" : "approval_required",
		};
	});
	manifest.contributes = { skills: [], commands: [], tools };
	manifest.runtime = {
		kind: "remote_mcp",
		supportedExecutors: ["oho_client"],
		protocolVersion: "2025-06-18",
		endpoint: {
			kind: "per_installation",
			baseUrlField: "base_url",
			path: `/mcp/${id}`,
		},
		auth: { kind: "bearer_token", secretField: "access_token" },
	};
	manifest.permissions = {
		network: [{ kind: "user_configured_origin", field: "base_url" }],
		secrets: ["access_token"],
	};
	manifest.connectionFields = [
		{
			id: "base_url",
			kind: "url",
			label: "插件服务地址",
			required: true,
			description: "填写已运行的插件服务地址。",
		},
		{
			id: "access_token",
			kind: "secret",
			label: "插件连接密钥",
			required: true,
			description: "用于连接插件服务，由服务的管理者提供。",
		},
	];
	manifest.toolPolicy = {
		discovery: "mcp_tools_list",
		allow: tools.map((tool) => tool.id),
		risk: Object.fromEntries(tools.map((tool) => [tool.id, tool.risk])),
		defaultMode: Object.fromEntries(
			tools.map((tool) => [tool.id, tool.defaultMode]),
		),
		maxCallsPerRun: Math.max(...tools.map((tool) => tool.maxCallsPerRun)),
	};
	manifest.compatibility = { ohoPackApi: "1", mcp: ["2025-06-18"] };
	const text = `${JSON.stringify(manifest, null, 2)}\n`;
	if (process.argv.includes("--check")) {
		if ((await readFile(path, "utf8")) !== text)
			throw new Error(`Stale tool catalog: ${id}. Run pnpm catalog:generate.`);
	} else {
		await writeFile(path, text);
	}
}
