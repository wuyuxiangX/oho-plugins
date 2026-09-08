import { describe, expect, it, vi } from "vitest";
import { GitHubClient } from "../plugins/oho/github/src/client.js";
import { GoogleWorkspaceClient } from "../providers/google-workspace/client.js";
import type { GmailClient } from "../plugins/oho/gmail/src/client.js";
import { LarkClient } from "../providers/lark/client.js";
import { NotionClient } from "../plugins/oho/notion/src/client.js";
import { ConnectorProviderError } from "../runtime/oauth.js";
import { GmailOAuthDriver } from "../plugins/oho/gmail/src/oauth.js";
import { SlackClient } from "../plugins/oho/slack/src/client.js";

describe("OAuth connector adapters", () => {
	it("builds a least-privilege GitHub PKCE flow and lists public repositories", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({ access_token: "gho_test", scope: "read:user" }),
			)
			.mockResolvedValueOnce(Response.json({ id: 42, login: "octocat" }))
			.mockResolvedValueOnce(
				Response.json(
					[
						{
							id: 1,
							name: "public",
							full_name: "octocat/public",
							description: null,
							html_url: "https://github.com/octocat/public",
							private: false,
							updated_at: "2026-08-13T00:00:00Z",
							language: "TypeScript",
						},
						{
							id: 2,
							name: "private",
							full_name: "octocat/private",
							description: "hidden",
							html_url: "https://github.com/octocat/private",
							private: true,
							updated_at: "2026-08-13T00:00:00Z",
							language: null,
						},
					],
					{
						headers: {
							Link: '<https://api.github.com/user/repos?page=2>; rel="next"',
						},
					},
				),
			);
		const client = new GitHubClient(
			"client-id",
			"client-secret",
			fetchImpl,
			() => new Date("2026-08-13T00:00:00Z"),
		);
		const authorization = client.authorizationUrl({
			state: "state",
			redirectUri: "https://oho.example/connectors/github/oauth/callback",
			codeChallenge: "challenge",
		});
		expect(authorization.searchParams.get("scope")).toBe("read:user");
		expect(authorization.searchParams.get("code_challenge")).toBe("challenge");
		expect(authorization.toString()).not.toContain("client-secret");

		const grant = await client.exchangeCode({
			code: "code",
			codeVerifier: "verifier",
			redirectUri: "https://oho.example/connectors/github/oauth/callback",
		});
		expect(grant.account).toEqual({ id: "42", label: "octocat" });
		expect(grant.credential).toMatchObject({
			connectorId: "github",
			scopes: ["read:user"],
		});
		await expect(
			client.listPublicRepositories("gho_test", { limit: 20, page: 1 }),
		).resolves.toEqual({
			items: [expect.objectContaining({ id: "1", fullName: "octocat/public" })],
			page: 1,
			hasMore: true,
		});
		expect(String(fetchImpl.mock.calls[2]?.[0])).toContain("visibility=public");
	});

	it("rejects over-scoped GitHub grants and guards every repository read by visibility", async () => {
		const overScoped = new GitHubClient(
			"client",
			"secret",
			vi
				.fn<typeof fetch>()
				.mockResolvedValue(
					Response.json({ access_token: "token", scope: "read:user,repo" }),
				),
		);
		await expect(
			overScoped.exchangeCode({
				code: "code",
				codeVerifier: "verifier",
				redirectUri: "https://oho.example/callback",
			}),
		).rejects.toMatchObject({ code: "github_scope_not_allowed", status: 403 });

		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ private: true }));
		const guarded = new GitHubClient("client", "secret", fetchImpl);
		await expect(
			guarded.readPublicRepositoryFile("token", {
				owner: "octocat",
				repository: "private",
				path: "README.md",
			}),
		).rejects.toMatchObject({
			code: "github_private_repository_not_available",
			status: 404,
		});
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
			"/repos/octocat/private",
		);
	});

	it("bounds GitHub public search, file, issue, and pull request results", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json(
					{
						items: [
							{
								id: 1,
								name: "public",
								full_name: "octocat/public",
								description: "Example",
								html_url: "https://github.com/octocat/public",
								private: false,
								updated_at: "2026-08-13T00:00:00Z",
								language: "TypeScript",
							},
						],
					},
					{
						headers: {
							Link: '<https://api.github.com/search/repositories?page=2>; rel="next"',
						},
					},
				),
			)
			.mockResolvedValueOnce(Response.json({ private: false }))
			.mockResolvedValueOnce(
				Response.json({
					type: "file",
					path: "README.md",
					sha: "abc",
					size: 6,
					encoding: "base64",
					content: Buffer.from("你好", "utf8").toString("base64"),
					html_url: "https://github.com/octocat/public/blob/main/README.md",
				}),
			)
			.mockResolvedValueOnce(Response.json({ private: false }))
			.mockResolvedValueOnce(
				Response.json({
					items: [
						{
							id: 11,
							number: 1,
							title: "Issue",
							body: "Body",
							html_url: "https://github.com/octocat/public/issues/1",
							state: "open",
							created_at: "2026-08-13T00:00:00Z",
							updated_at: "2026-08-13T00:00:00Z",
							closed_at: null,
							user: { login: "octocat" },
							labels: [{ name: "bug" }],
						},
						{
							id: 12,
							number: 2,
							title: "Pull request returned by issues API",
							body: null,
							html_url: "https://github.com/octocat/public/pull/2",
							state: "open",
							created_at: "2026-08-13T00:00:00Z",
							updated_at: "2026-08-13T00:00:00Z",
							closed_at: null,
							user: { login: "octocat" },
							labels: [],
							pull_request: {},
						},
					],
				}),
			)
			.mockResolvedValueOnce(Response.json({ private: false }))
			.mockResolvedValueOnce(
				Response.json([
					{
						sha: "def",
						filename: "src/index.ts",
						status: "modified",
						additions: 1,
						deletions: 1,
						changes: 2,
						patch: "x".repeat(20_000),
					},
				]),
			);
		const client = new GitHubClient("client", "secret", fetchImpl);

		await expect(
			client.searchPublicRepositories("token", {
				query: "agent tools",
				limit: 10,
				page: 1,
			}),
		).resolves.toMatchObject({ page: 1, hasMore: true, items: [{ id: "1" }] });
		expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
			"q=agent+tools+is%3Apublic",
		);
		await expect(
			client.readPublicRepositoryFile("token", {
				owner: "octocat",
				repository: "public",
				path: "README.md",
			}),
		).resolves.toMatchObject({ content: "你好", size: 6 });
		await expect(
			client.listIssues("token", {
				owner: "octocat",
				repository: "public",
				state: "open",
				limit: 20,
				page: 1,
			}),
		).resolves.toMatchObject({ items: [{ id: "11", number: 1 }] });
		const files = await client.listPullRequestFiles("token", {
			owner: "octocat",
			repository: "public",
			number: 2,
			limit: 20,
			page: 1,
		});
		expect(files.items[0]?.patch).toHaveLength(8_192);
	});

	it("uses Slack user scopes with PKCE, caps history, and posts idempotent plain text", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					ok: true,
					authed_user: {
						id: "U1",
						access_token: "xoxp-test",
						scope: "channels:read,channels:history,chat:write",
					},
					team: { id: "T1", name: "Oho Workspace" },
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					ok: true,
					messages: [{ ts: "1.000", user: "U1", text: "hello" }],
				}),
			)
			.mockResolvedValueOnce(
				Response.json(
					{ ok: true, channel: "C1", ts: "2.000" },
					{ headers: { "x-slack-req-id": "req-123" } },
				),
			);
		const client = new SlackClient("client", fetchImpl);
		const authorization = client.authorizationUrl({
			state: "state",
			redirectUri: "https://oho.example/connectors/slack/oauth/callback",
			codeChallenge: "challenge",
		});
		expect(authorization.searchParams.get("user_scope")).toBe(
			"channels:read,channels:history,chat:write",
		);
		expect(authorization.searchParams.has("scope")).toBe(false);
		expect(authorization.searchParams.get("code_challenge")).toBe("challenge");
		expect(authorization.searchParams.get("code_challenge_method")).toBe(
			"S256",
		);
		await expect(
			client.exchangeCode({
				code: "code",
				codeVerifier: "verifier",
				redirectUri: "https://oho.example/connectors/slack/oauth/callback",
			}),
		).resolves.toMatchObject({ account: { id: "T1", label: "Oho Workspace" } });
		const tokenBody = String(fetchImpl.mock.calls[0]?.[1]?.body);
		expect(tokenBody).toContain("client_id=client");
		expect(tokenBody).toContain("code_verifier=verifier");
		expect(tokenBody).not.toContain("secret");
		await client.readChannelMessages("xoxp-test", "C1", 99);
		expect(String(fetchImpl.mock.calls[1]?.[1]?.body)).toContain("limit=15");
		await expect(
			client.postMessage("xoxp-test", {
				channelId: "C1",
				text: "Release is ready.",
				clientMessageId: "4d8e7a02-0f58-4aef-a307-75c0d17c24f9",
			}),
		).resolves.toEqual({
			id: "C1:2.000",
			resourceId: "C1:2.000",
			providerRequestId: "req-123",
			channelId: "C1",
			timestamp: "2.000",
		});
		const postBody = String(fetchImpl.mock.calls[2]?.[1]?.body);
		expect(String(fetchImpl.mock.calls[2]?.[0])).toContain("chat.postMessage");
		expect(postBody).toContain("channel=C1");
		expect(postBody).toContain("text=Release+is+ready.");
		expect(postBody).toContain(
			"client_msg_id=4d8e7a02-0f58-4aef-a307-75c0d17c24f9",
		);
		expect(postBody).toContain("mrkdwn=false");
	});

	it("binds Notion OAuth to user-selected pages and bounds page content", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					access_token: "ntn_test",
					refresh_token: "refresh",
					workspace_id: "workspace-1",
					workspace_name: "Product",
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					id: "page-1",
					url: "https://notion.so/page-1",
					last_edited_time: "2026-08-13T00:00:00Z",
					properties: {
						Name: {
							type: "title",
							title: [{ plain_text: "Roadmap" }],
						},
					},
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					results: [
						{
							type: "paragraph",
							paragraph: { rich_text: [{ plain_text: "Plan" }] },
						},
					],
					has_more: false,
				}),
			);
		const client = new NotionClient("client", "secret", fetchImpl);
		const authorization = client.authorizationUrl({
			state: "state",
			redirectUri: "https://oho.example/connectors/notion/oauth/callback",
		});
		expect(authorization.searchParams.get("owner")).toBe("user");
		expect(authorization.searchParams.has("scope")).toBe(false);
		await expect(
			client.exchangeCode({
				code: "code",
				redirectUri: "https://oho.example/connectors/notion/oauth/callback",
			}),
		).resolves.toMatchObject({
			account: { id: "workspace-1", label: "Product" },
		});
		await expect(client.readPage("ntn_test", "page-1")).resolves.toMatchObject({
			id: "page-1",
			title: "Roadmap",
			text: "Plan",
			truncated: false,
			hasMore: false,
		});
	});

	it("truncates Notion text on a UTF-8 character boundary", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					id: "page-1",
					url: "https://notion.so/page-1",
					last_edited_time: "2026-08-13T00:00:00Z",
					properties: {},
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					results: [
						{
							type: "paragraph",
							paragraph: {
								rich_text: [{ plain_text: `${"a".repeat(65_535)}你` }],
							},
						},
					],
					has_more: false,
				}),
			);
		const page = await new NotionClient("client", "secret", fetchImpl).readPage(
			"token",
			"page-1",
		);
		expect(page.truncated).toBe(true);
		expect(Buffer.byteLength(page.text, "utf8")).toBe(65_535);
		expect(page.text).not.toContain("�");
	});

	it("reads Notion properties and paginated block children with the pinned API version", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					id: "page-1",
					url: "https://notion.so/page-1",
					last_edited_time: "2026-08-13T00:00:00Z",
					properties: {
						Name: { type: "title", title: [{ plain_text: "Roadmap" }] },
						Status: { type: "status", status: { name: "In progress" } },
					},
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					results: [
						{
							id: "block-1",
							type: "paragraph",
							has_children: true,
							paragraph: { rich_text: [{ plain_text: "Plan" }] },
						},
					],
					has_more: true,
					next_cursor: "cursor-2",
				}),
			);
		const client = new NotionClient("client", "secret", fetchImpl);
		await expect(
			client.readPageMetadata("token", "page-1"),
		).resolves.toMatchObject({
			id: "page-1",
			properties: [
				{ name: "Name", type: "title", value: "Roadmap" },
				{ name: "Status", type: "status", value: "In progress" },
			],
		});
		await expect(
			client.listBlockChildren("token", {
				blockId: "page-1",
				limit: 50,
				cursor: "cursor-1",
			}),
		).resolves.toEqual({
			blocks: [
				{ id: "block-1", type: "paragraph", hasChildren: true, text: "Plan" },
			],
			nextCursor: "cursor-2",
		});
		const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<
			string,
			string
		>;
		expect(headers["Notion-Version"]).toBe("2026-03-11");
		expect(String(fetchImpl.mock.calls[1]?.[0])).toContain(
			"start_cursor=cursor-1",
		);
	});

	it("uses Lark PKCE, exact read scopes, refresh rotation, and task pagination", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					code: 0,
					access_token: "uat-1",
					refresh_token: "refresh-1",
					expires_in: 7200,
					refresh_token_expires_in: 604800,
					scope: "offline_access task:task:read",
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					code: 0,
					data: { open_id: "ou_1", name: "张三" },
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					code: 0,
					data: {
						items: [{ guid: "task-1", summary: "Review" }],
						page_token: "next",
						has_more: true,
					},
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					code: 0,
					access_token: "uat-2",
					refresh_token: "refresh-2",
					expires_in: 7200,
					refresh_token_expires_in: 604800,
					scope: "offline_access task:task:read",
				}),
			);
		const client = new LarkClient(
			"client",
			"secret",
			fetchImpl,
			() => new Date("2026-08-13T00:00:00Z"),
		);
		const authorization = client.authorizationUrl({
			state: "state",
			redirectUri: "https://oho.example/connectors/lark/oauth/callback",
			codeChallenge: "challenge",
		});
		expect(authorization.searchParams.get("scope")).toBe(
			"offline_access task:task:read",
		);
		expect(authorization.searchParams.get("code_challenge_method")).toBe(
			"S256",
		);
		const grant = await client.exchangeCode({
			code: "code",
			codeVerifier: "verifier",
			redirectUri: "https://oho.example/connectors/lark/oauth/callback",
		});
		expect(grant.account).toEqual({ id: "ou_1", label: "张三" });
		await expect(client.listTasks("uat-1", 20, undefined)).resolves.toEqual({
			tasks: [
				{
					id: "task-1",
					summary: "Review",
					description: "",
				},
			],
			nextPageToken: "next",
		});
		await expect(client.refreshToken(grant.credential)).resolves.toMatchObject({
			accessToken: "uat-2",
			refreshToken: "refresh-2",
		});
	});

	it("reads one explicit Feishu or Lark task without expanding scopes", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				code: 0,
				data: {
					task: {
						guid: "task-1",
						summary: "Review",
						description: "Check release",
					},
				},
			}),
		);
		const client = new LarkClient("client", "secret", fetchImpl);
		await expect(client.getTask("token", "task-1")).resolves.toEqual({
			id: "task-1",
			summary: "Review",
			description: "Check release",
		});
		expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
			"/task/v2/tasks/task-1",
		);
	});

	it("reads Slack channel details and one cursor-bounded thread page", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					ok: true,
					channel: {
						id: "C1",
						name: "general",
						topic: { value: "Updates" },
						is_member: true,
					},
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					ok: true,
					messages: [
						{ ts: "2.000", user: "U1", text: "Reply", thread_ts: "1.000" },
					],
					response_metadata: { next_cursor: "cursor-2" },
				}),
			);
		const client = new SlackClient("client", fetchImpl);
		await expect(client.getChannel("token", "C1")).resolves.toMatchObject({
			id: "C1",
			name: "general",
		});
		await expect(
			client.readThreadReplies("token", {
				channelId: "C1",
				threadTimestamp: "1.000",
				limit: 99,
				cursor: "cursor-1",
			}),
		).resolves.toEqual({
			messages: [
				{
					timestamp: "2.000",
					userId: "U1",
					text: "Reply",
					threadTimestamp: "1.000",
				},
			],
			nextCursor: "cursor-2",
		});
		const body = String(fetchImpl.mock.calls[1]?.[1]?.body);
		expect(body).toContain("limit=15");
		expect(body).toContain("cursor=cursor-1");
	});

	it("uses shared Slack mappers while preserving list-skip and get-throw semantics", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					ok: true,
					channels: [
						{ id: "C1", name: "general", topic: { value: "Updates" } },
						{ id: "C2" },
					],
				}),
			)
			.mockResolvedValueOnce(
				Response.json({ ok: true, channel: { id: "C2" } }),
			);
		const client = new SlackClient("client", fetchImpl);

		await expect(client.listChannels("token", 20)).resolves.toEqual([
			expect.objectContaining({ id: "C1", name: "general" }),
		]);
		await expect(client.getChannel("token", "C2")).rejects.toMatchObject({
			code: "channel_identity_missing",
		});
	});

	it("preserves provider retry guidance without hidden retries", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json(
					{ message: "rate limited" },
					{ status: 429, headers: { "Retry-After": "2" } },
				),
			);
		const client = new GitHubClient("client", "secret", fetchImpl);
		const error = await client
			.getAccount("token")
			.catch((value: unknown) => value);
		expect(error).toEqual(
			expect.objectContaining<Partial<ConnectorProviderError>>({
				code: "rate_limited",
				status: 429,
				retryAfterMs: 2_000,
			}),
		);
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("revokes Gmail with the refresh token while access-token providers use their own credential", async () => {
		const revokeToken = vi.fn(async () => undefined);
		const driver = new GmailOAuthDriver({
			revokeToken,
		} as unknown as GmailClient);
		await driver.revokeCredential({
			schemaVersion: "connector.oauth.v1",
			connectorId: "gmail",
			accessToken: "access-token",
			refreshToken: "refresh-token",
			scopes: [],
		});
		expect(revokeToken).toHaveBeenCalledWith("refresh-token");
	});

	it("keeps Feishu China and Lark international OAuth endpoints separate", () => {
		const input = {
			state: "state",
			redirectUri: "https://oho.example/callback",
			codeChallenge: "challenge",
		};
		const feishu = new LarkClient(
			"client",
			"secret",
			fetch,
			() => new Date(),
			"feishu",
		);
		const lark = new LarkClient("client", "secret");

		expect(feishu.authorizationUrl(input).host).toBe("accounts.feishu.cn");
		expect(lark.authorizationUrl(input).host).toBe("accounts.larksuite.com");
		expect(feishu.connectorId).toBe("feishu");
		expect(lark.connectorId).toBe("lark");
	});

	it("uses isolated least-privilege Google Workspace grants and bounded service calls", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					access_token: "google-access",
					refresh_token: "google-refresh",
					expires_in: 3600,
					scope:
						"openid email https://www.googleapis.com/auth/spreadsheets.readonly",
				}),
			)
			.mockResolvedValueOnce(
				Response.json({ sub: "google-user", email: "user@example.com" }),
			)
			.mockResolvedValueOnce(
				Response.json({
					range: "Sheet1!A1:B2",
					values: [
						["Name", "Status"],
						["Oho", "Ready"],
					],
				}),
			);
		const client = new GoogleWorkspaceClient(
			"google_sheets",
			["https://www.googleapis.com/auth/spreadsheets.readonly"],
			"client",
			"secret",
			fetchImpl,
			() => new Date("2026-08-13T00:00:00Z"),
		);
		const authorization = client.authorizationUrl({
			state: "state",
			redirectUri:
				"https://oho.example/connectors/google_sheets/oauth/callback",
			codeChallenge: "challenge",
		});
		expect(authorization.searchParams.get("scope")?.split(" ")).toEqual([
			"openid",
			"email",
			"https://www.googleapis.com/auth/spreadsheets.readonly",
		]);
		expect(authorization.searchParams.get("include_granted_scopes")).toBe(
			"false",
		);
		expect(authorization.searchParams.get("code_challenge_method")).toBe(
			"S256",
		);
		await expect(
			client.exchangeCode({
				code: "code",
				codeVerifier: "verifier",
				redirectUri:
					"https://oho.example/connectors/google_sheets/oauth/callback",
			}),
		).resolves.toMatchObject({
			account: { id: "google-user", label: "user@example.com" },
			credential: { connectorId: "google_sheets" },
		});
		await expect(
			client.readSheetValues("google-access", "spreadsheet-1", "Sheet1!A1:B2"),
		).resolves.toEqual({
			range: "Sheet1!A1:B2",
			values: [
				["Name", "Status"],
				["Oho", "Ready"],
			],
			truncated: false,
		});
		expect(String(fetchImpl.mock.calls[2]?.[0])).toContain(
			"/spreadsheets/spreadsheet-1/values/Sheet1!A1%3AB2",
		);
	});

	it("supports bounded Google Calendar, Drive, and Sheets detail reads without broader scopes", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async (input) => {
			const url = String(input);
			if (url.includes("calendarList"))
				return Response.json({
					items: [{ id: "primary", summary: "Work", primary: true }],
				});
			if (url.includes("/events/event-1"))
				return Response.json({ id: "event-1", summary: "Review" });
			if (url.endsWith("/freeBusy"))
				return Response.json({
					calendars: {
						primary: {
							busy: [
								{ start: "2026-08-13T01:00:00Z", end: "2026-08-13T02:00:00Z" },
							],
						},
					},
				});
			if (url.includes("/drive/v3/files/file-1"))
				return Response.json({
					id: "file-1",
					name: "Spec",
					mimeType: "text/plain",
					size: "12",
				});
			if (url.includes("/drive/v3/files") && url.includes("pageSize"))
				return Response.json({
					files: [{ id: "file-2", name: "Child" }],
					nextPageToken: "next",
				});
			if (url.includes("values:batchGet"))
				return Response.json({
					valueRanges: [{ range: "Sheet1!A1", values: [["Ready"]] }],
				});
			return Response.json({
				spreadsheetId: "sheet-1",
				properties: { title: "Plan" },
				sheets: [
					{
						properties: {
							sheetId: 0,
							title: "Sheet1",
							index: 0,
							gridProperties: { rowCount: 10, columnCount: 5 },
						},
					},
				],
			});
		});
		const calendar = new GoogleWorkspaceClient(
			"google_calendar",
			[],
			undefined,
			undefined,
			fetchImpl,
		);
		const drive = new GoogleWorkspaceClient(
			"google_drive",
			[],
			undefined,
			undefined,
			fetchImpl,
		);
		const sheets = new GoogleWorkspaceClient(
			"google_sheets",
			[],
			undefined,
			undefined,
			fetchImpl,
		);
		await expect(calendar.listCalendars("token", 25)).resolves.toEqual([
			expect.objectContaining({ id: "primary", primary: true }),
		]);
		await expect(
			calendar.readCalendarEvent("token", "primary", "event-1"),
		).resolves.toMatchObject({ id: "event-1" });
		await expect(
			calendar.readCalendarFreeBusy("token", {
				timeMin: "2026-08-13T00:00:00Z",
				timeMax: "2026-08-14T00:00:00Z",
				calendarIds: ["primary"],
			}),
		).resolves.toEqual([
			{
				id: "primary",
				busy: [{ start: "2026-08-13T01:00:00Z", end: "2026-08-13T02:00:00Z" }],
				errors: [],
			},
		]);
		await expect(drive.readDriveFile("token", "file-1")).resolves.toMatchObject(
			{ id: "file-1", size: "12" },
		);
		await expect(
			drive.listDriveFolderChildren("token", {
				folderId: "folder-1",
				limit: 50,
			}),
		).resolves.toMatchObject({
			files: [{ id: "file-2" }],
			nextPageToken: "next",
		});
		await expect(
			sheets.readSpreadsheetMetadata("token", "sheet-1"),
		).resolves.toMatchObject({
			id: "sheet-1",
			sheets: [{ id: 0, rowCount: 10 }],
		});
		await expect(
			sheets.readSheetValueRanges("token", "sheet-1", ["Sheet1!A1"]),
		).resolves.toEqual([
			{ range: "Sheet1!A1", values: [["Ready"]], truncated: false },
		]);
	});

	it("rejects unbounded Google Sheets ranges before dispatch and enforces the batch budget", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				range: "'FY 2026'!A1:B2",
				values: [["x".repeat(4_097)]],
			}),
		);
		const sheets = new GoogleWorkspaceClient(
			"google_sheets",
			[],
			undefined,
			undefined,
			fetchImpl,
		);

		await expect(
			sheets.readSheetValues("token", "sheet-1", "'FY 2026'!A1:B2"),
		).resolves.toMatchObject({ truncated: true });
		for (const range of ["Sheet1", "A:A", "Sheet1!A1:A201", "A1:AY1"]) {
			await expect(
				sheets.readSheetValues("token", "sheet-1", range),
			).rejects.toMatchObject({ status: 400 });
		}
		await expect(
			sheets.readSheetValueRanges("token", "sheet-1", [
				"A1:AX200",
				"A1:AX200",
				"A1:AX200",
			]),
		).rejects.toMatchObject({ code: "sheet_batch_too_large", status: 400 });
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("rejects oversized Google Sheets responses before JSON parsing", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			new Response("{}", {
				headers: { "Content-Length": String(1024 * 1024 + 1) },
			}),
		);
		const sheets = new GoogleWorkspaceClient(
			"google_sheets",
			[],
			undefined,
			undefined,
			fetchImpl,
		);
		await expect(
			sheets.readSheetValues("token", "sheet-1", "A1:B2"),
		).rejects.toMatchObject({
			code: "google_response_too_large",
			status: 413,
		});
	});
});
