import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { z } from "zod";
import { createPluginTools, type PluginId } from "./plugins.js";
import type { ConnectorId } from "./provider-metadata.js";
import { ProviderService, type ProviderCredential } from "./service.js";
import { ToolImplementationError } from "./tool.js";

const protocolVersion = "2025-06-18";
const maxBytes = 1024 * 1024;
const rpcSchema = z
	.object({
		jsonrpc: z.literal("2.0"),
		id: z.union([z.string().max(256), z.number().finite()]).optional(),
		method: z.string().max(128),
		params: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();

/** One server is bound to one plugin/account. Request arguments cannot select credentials. */
export function createPluginMcpServer(input: {
	pluginId: PluginId;
	bridgeToken: string;
	credential: ProviderCredential;
	fetchImpl?: typeof fetch;
}) {
	if (
		input.bridgeToken.length < 32 ||
		input.bridgeToken === input.credential.accessToken
	) {
		throw new Error(
			"Use a separate random bridge token of at least 32 characters",
		);
	}
	if (!input.credential.accessToken || !input.credential.version)
		throw new Error("Provider credential is required");
	const credential = Object.freeze({ ...input.credential });
	const userId = randomUUID();
	const connectionId = randomUUID();
	const connectorId = input.pluginId.replaceAll("-", "_") as ConnectorId;
	const service = new ProviderService(async (binding) => {
		if (
			binding.userId !== userId ||
			binding.connectionId !== connectionId ||
			binding.connectorId !== connectorId
		) {
			throw new Error("connection_binding_mismatch");
		}
		return credential;
	}, input.fetchImpl);
	const tools = createPluginTools(input.pluginId, service);
	const byName = new Map(
		tools.map((tool) => [tool.manifest.runtimeName, tool]),
	);
	const expectedToken = createHash("sha256")
		.update(`Bearer ${input.bridgeToken}`)
		.digest();
	const active = new Map<string, AbortController>();
	const sessions = new Map<string, number>();
	const closeSession = (sessionId: string) => {
		sessions.delete(sessionId);
		for (const [key, controller] of active)
			if (key.startsWith(`${sessionId}:`)) controller.abort();
	};
	let windowStart = Date.now();
	let requestCount = 0;

	async function handle(req: IncomingMessage, res: ServerResponse) {
		const reply = (status: number, body?: unknown) => {
			const text = body === undefined ? "" : JSON.stringify(body);
			if (Buffer.byteLength(text) > maxBytes) {
				res.writeHead(502).end();
				return;
			}
			res
				.writeHead(status, {
					"Content-Type": "application/json",
					"Cache-Control": "no-store",
				})
				.end(text);
		};
		// Loopback only; Origin and Host checks also protect against DNS rebinding.
		const authority = `127.0.0.1:${req.socket.localPort}`;
		if (
			req.headers.host !== authority ||
			(req.headers.origin && req.headers.origin !== `http://${authority}`)
		)
			return reply(403);
		if (req.url !== `/mcp/${input.pluginId}`) return reply(404);
		const token = createHash("sha256")
			.update(req.headers.authorization ?? "")
			.digest();
		if (!timingSafeEqual(expectedToken, token)) return reply(401);
		const sessionHeader = req.headers["mcp-session-id"];
		const sessionId =
			typeof sessionHeader === "string" ? sessionHeader : undefined;
		for (const [id, touchedAt] of sessions)
			if (Date.now() - touchedAt > 300_000) closeSession(id);
		if (req.method === "DELETE") {
			if (!sessionId || !sessions.has(sessionId)) return reply(404);
			closeSession(sessionId);
			return reply(200);
		}
		if (req.method !== "POST") {
			res.setHeader("Allow", "POST, DELETE");
			return reply(405);
		}
		if (
			req.headers["mcp-protocol-version"] &&
			req.headers["mcp-protocol-version"] !== protocolVersion
		)
			return reply(400);
		if (!req.headers["content-type"]?.startsWith("application/json"))
			return reply(415);
		if (Date.now() - windowStart >= 60_000) {
			windowStart = Date.now();
			requestCount = 0;
		}
		if (++requestCount > 240) {
			res.setHeader("Retry-After", "60");
			return reply(429);
		}
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += chunk.length;
			if (size > maxBytes) return reply(413);
			chunks.push(Buffer.from(chunk));
		}
		let value: unknown;
		try {
			value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			return reply(400, {
				jsonrpc: "2.0",
				id: null,
				error: { code: -32700, message: "Parse error" },
			});
		}
		const parsed = rpcSchema.safeParse(value);
		if (!parsed.success)
			return reply(400, {
				jsonrpc: "2.0",
				id: null,
				error: { code: -32600, message: "Invalid request" },
			});
		const rpc = parsed.data;
		if (rpc.method !== "initialize") {
			if (!sessionId) return reply(400);
			if (!sessions.has(sessionId)) return reply(404);
			sessions.set(sessionId, Date.now());
		}
		const activeKey = (id: string | number) =>
			`${sessionId}:${JSON.stringify(id)}`;
		const error = (code: number, message: string) =>
			reply(200, { jsonrpc: "2.0", id: rpc.id, error: { code, message } });
		const result = (result: unknown) =>
			reply(200, { jsonrpc: "2.0", id: rpc.id, result });
		if (rpc.id === undefined) {
			if (rpc.method === "notifications/cancelled") {
				const requestId = rpc.params?.requestId;
				if (typeof requestId === "string" || typeof requestId === "number")
					active.get(activeKey(requestId))?.abort();
			}
			return reply(202);
		}
		if (rpc.method === "initialize") {
			if (sessions.size >= 64) return error(-32000, "Too many sessions");
			const id = randomUUID();
			sessions.set(id, Date.now());
			res.setHeader("Mcp-Session-Id", id);
			return result({
				protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: `oho-${input.pluginId}`, version: "1.0.0" },
			});
		}
		if (rpc.method === "ping") return result({});
		if (rpc.method === "tools/list")
			return result({
				tools: tools.map(({ manifest }) => ({
					name: manifest.runtimeName,
					title: manifest.label,
					description: manifest.description,
					inputSchema: manifest.inputSchema,
					outputSchema: manifest.outputSchema,
					annotations: {
						readOnlyHint: manifest.sideEffect === "none",
						destructiveHint: manifest.sideEffect === "irreversible",
						openWorldHint: true,
					},
				})),
			});
		if (rpc.method !== "tools/call") return error(-32601, "Method not found");
		const tool =
			typeof rpc.params?.name === "string"
				? byName.get(rpc.params.name)
				: undefined;
		if (!tool) return error(-32602, "Unknown tool");
		if (tool.manifest.sideEffect !== "none")
			return result({
				isError: true,
				content: [
					{
						type: "text",
						text: "approval_host_required: This operation requires a host with durable user approval and resume support.",
					},
				],
			});
		const args = tool.inputValidator.safeParse(rpc.params?.arguments ?? {});
		if (!args.success) return error(-32602, "Invalid tool arguments");
		if (active.size >= 4 || active.has(activeKey(rpc.id)))
			return error(-32000, "Too many active requests or duplicate request ID");
		const controller = new AbortController();
		active.set(activeKey(rpc.id), controller);
		const signal = AbortSignal.any([
			controller.signal,
			AbortSignal.timeout(tool.manifest.timeoutMs),
		]);
		try {
			const output = tool.outputValidator.parse(
				await tool.execute(args.data, {
					userId,
					agentConnectionId: connectionId,
					runId: randomUUID(),
					toolCallId: String(rpc.id),
					operationId: tool.manifest.id,
					policyHash: tool.manifest.schemaHash,
					defaultTimeZone: "UTC",
					signal,
				}),
			);
			return result({
				structuredContent: output,
				content: [
					{
						type: "text",
						text: tool.toModelContent?.(output) ?? JSON.stringify(output),
					},
				],
			});
		} catch (failure) {
			const code = signal.aborted
				? controller.signal.aborted
					? "cancelled"
					: "timeout"
				: failure instanceof ToolImplementationError
					? failure.code
					: "provider_error";
			return result({ isError: true, content: [{ type: "text", text: code }] });
		} finally {
			active.delete(activeKey(rpc.id));
		}
	}
	const server = createServer((req, res) => {
		void handle(req, res).catch(() => {
			if (!res.headersSent) res.writeHead(500);
			res.end();
		});
	});
	server.requestTimeout = 30_000;
	server.headersTimeout = 10_000;
	server.on("close", () => {
		for (const controller of active.values()) controller.abort();
	});
	return server;
}
