import { createPluginMcpServer } from "./mcp-server.js";
import { pluginIds, type PluginId } from "./plugins.js";

const pluginId = process.argv[2];
if (!pluginIds.includes(pluginId as PluginId))
	throw new Error(`Choose a plugin: ${pluginIds.join(", ")}`);
const bridgeToken = process.env.OHO_PLUGIN_MCP_TOKEN;
const accessToken = process.env.OHO_PLUGIN_PROVIDER_TOKEN;
if (!bridgeToken || !accessToken)
	throw new Error(
		"Set OHO_PLUGIN_MCP_TOKEN and OHO_PLUGIN_PROVIDER_TOKEN through your secret manager or local environment",
	);
const port = Number(process.env.OHO_PLUGIN_PORT ?? "0");
if (!Number.isInteger(port) || port < 0 || port > 65535)
	throw new Error("Invalid OHO_PLUGIN_PORT");
const server = createPluginMcpServer({
	pluginId: pluginId as PluginId,
	bridgeToken,
	credential: {
		accessToken,
		version: "1",
		...(process.env.OHO_PLUGIN_TOKEN_EXPIRES_AT
			? { expiresAt: process.env.OHO_PLUGIN_TOKEN_EXPIRES_AT }
			: {}),
	},
});
delete process.env.OHO_PLUGIN_MCP_TOKEN;
delete process.env.OHO_PLUGIN_PROVIDER_TOKEN;
server.listen(port, "127.0.0.1", () => {
	const address = server.address();
	if (address && typeof address === "object")
		console.log(
			`Plugin endpoint: http://127.0.0.1:${address.port}/mcp/${pluginId}`,
		);
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		server.closeAllConnections();
		server.close();
	});
