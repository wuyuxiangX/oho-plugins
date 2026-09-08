import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMcpServer } from "../runtime/mcp-server.js";
import {
	createPluginTools,
	pluginIds,
	type PluginId,
} from "../runtime/plugins.js";
import { ProviderService } from "../runtime/service.js";

const bridgeToken = "test-only-bridge-token-01234567890123456789";
const servers: Server[] = [];
const counts = {
	github: 15,
	gmail: 7,
	slack: 5,
	notion: 4,
	feishu: 2,
	lark: 2,
	"google-calendar": 4,
	"google-drive": 3,
	"google-sheets": 3,
	linear: 6,
	stripe: 3,
	resend: 1,
};

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.closeAllConnections();
					server.close((error) => (error ? reject(error) : resolve()));
				}),
		),
	);
});

async function start(
	pluginId: PluginId,
	fetchImpl = vi.fn<typeof fetch>(),
	expiresAt?: string,
) {
	const server = createPluginMcpServer({
		pluginId,
		bridgeToken,
		credential: {
			accessToken: "fixture-provider-token",
			version: "1",
			expiresAt,
		},
		fetchImpl,
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing test port");
	const url = `http://127.0.0.1:${address.port}/mcp/${pluginId}`;
	let id = 0;
	let sessionId: string | null = null;
	const request = async (
		method: string,
		params: unknown = {},
		headers: Record<string, string> = {},
	) => {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${bridgeToken}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": "2025-06-18",
				...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
				...headers,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
		});
		sessionId = response.headers.get("mcp-session-id") ?? sessionId;
		return response;
	};
	await request("initialize", { protocolVersion: "2025-06-18" });
	return { url, request, fetchImpl };
}

describe("migrated plugin MCP bridge", () => {
	it.each(pluginIds)(
		"discovers the real %s handlers and their committed catalog without provider access",
		async (id) => {
			const { request, fetchImpl } = await start(id);
			const init = await (
				await request("initialize", { protocolVersion: "2025-06-18" })
			).json();
			expect(init.result.protocolVersion).toBe("2025-06-18");
			const { result } = await (await request("tools/list")).json();
			const manifest = JSON.parse(
				await readFile(
					new URL(`../plugins/oho/${id}/oho.plugin.json`, import.meta.url),
					"utf8",
				),
			);
			expect(result.tools).toHaveLength(counts[id]);
			expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual(
				manifest.toolPolicy.allow,
			);
			for (const tool of result.tools) {
				expect(
					manifest.contributes.tools.find(
						(entry: { id: string }) => entry.id === tool.name,
					),
				).toMatchObject({
					inputSchema: tool.inputSchema,
					outputSchema: tool.outputSchema,
					label: tool.title,
				});
			}
			expect(JSON.stringify(result)).not.toContain("fixture-provider-token");
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);

	it("executes a GitHub read through the migrated handler and client with scoped credentials", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json([
					{
						id: 1,
						name: "public",
						full_name: "example/public",
						private: false,
						description: "Fixture",
						html_url: "https://github.com/example/public",
						updated_at: "2026-09-08T00:00:00Z",
						language: null,
					},
				]),
			);
		const { request } = await start("github", fetchImpl);
		const manifest = JSON.parse(
			await readFile(
				new URL("../plugins/oho/github/oho.plugin.json", import.meta.url),
				"utf8",
			),
		);
		const response = await (
			await request("tools/call", {
				name: manifest.toolPolicy.allow[0],
				arguments: { limit: 1 },
			})
		).json();
		expect(response.result.isError).not.toBe(true);
		expect(JSON.stringify(response.result.structuredContent)).toContain(
			"example/public",
		);
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
			"https://api.github.com/user/repos",
		);
		expect(
			new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("Authorization"),
		).toBe("Bearer fixture-provider-token");
	});

	it("rejects unauthenticated requests, untrusted origins, wrong plugins and unsupported protocol versions", async () => {
		const { request, url, fetchImpl } = await start("github");
		expect(
			(await request("tools/list", {}, { Authorization: "Bearer incorrect" }))
				.status,
		).toBe(401);
		expect(
			(await request("tools/list", {}, { Origin: "https://untrusted.example" }))
				.status,
		).toBe(403);
		expect(
			(
				await request(
					"tools/list",
					{},
					{ "MCP-Protocol-Version": "unexpected" },
				)
			).status,
		).toBe(400);
		expect((await fetch(url.replace("github", "gmail"))).status).toBe(404);
		const other = await (
			await request("tools/call", { name: "gmail_search", arguments: {} })
		).json();
		expect(other.error.code).toBe(-32602);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("fails closed for expired accounts and invalid arguments without provider calls", async () => {
		const { request, fetchImpl } = await start(
			"gmail",
			vi.fn<typeof fetch>(),
			"2020-01-01T00:00:00Z",
		);
		const invalid = await (
			await request("tools/call", {
				name: "gmail_search",
				arguments: { query: "in:inbox", limit: 10000 },
			})
		).json();
		expect(invalid.error.code).toBe(-32602);
		const expired = await (
			await request("tools/call", { name: "gmail_list_labels", arguments: {} })
		).json();
		expect(expired.result.isError).toBe(true);
		expect(JSON.stringify(expired)).not.toContain("fixture-provider-token");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it.each(["gmail", "slack", "resend"] as const)(
		"keeps %s writes blocked before any credential or provider access",
		async (id) => {
			const { request, fetchImpl } = await start(id);
			const service = new ProviderService(async () => {
				throw new Error("Must not resolve credentials");
			});
			const tools = createPluginTools(id, service).filter(
				(tool) => tool.manifest.sideEffect !== "none",
			);
			for (const tool of tools) {
				const response = await (
					await request("tools/call", {
						name: tool.manifest.runtimeName,
						arguments: {},
					})
				).json();
				expect(response.result).toMatchObject({
					isError: true,
					content: [
						{ text: expect.stringContaining("approval_host_required") },
					],
				});
			}
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);

	it("retains send proposal delegation for hosts that implement durable approval", async () => {
		const proposals = {
			createGmailSendProposal: vi.fn(async () => ({
				id: "proposal-1",
				summary: "Confirm this draft",
			})),
			createSlackMessageProposal: vi.fn(async () => ({
				id: "proposal-2",
				summary: "Confirm this message",
			})),
			createResendSendProposal: vi.fn(async () => ({
				id: "proposal-3",
				summary: "Confirm this email",
			})),
		};
		const resolve = vi.fn(async () => {
			throw new Error("No direct provider access");
		});
		const tool = createPluginTools(
			"gmail",
			new ProviderService(resolve),
			proposals,
		).find((tool) => tool.manifest.id === "gmail.draft.send")!;
		await tool.execute(tool.inputValidator.parse({ draftId: "draft-1" }), {
			userId: "owner",
			runId: "run",
			toolCallId: "call",
			agentConnectionId: "connection",
			operationId: "gmail.draft.send",
			policyHash: "policy",
			defaultTimeZone: "UTC",
		});
		expect(proposals.createGmailSendProposal).toHaveBeenCalledWith(
			expect.objectContaining({
				draftId: "draft-1",
				userId: "owner",
				connectionId: "connection",
				policyHash: "policy",
			}),
		);
		expect(resolve).not.toHaveBeenCalled();
	});
});
