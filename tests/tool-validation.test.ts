import { ProviderService } from "../runtime/service.js";
import { unavailableProposals } from "../runtime/plugins.js";
const service = new ProviderService(async () => {
	throw new Error("No credentials in validation tests");
});
import { describe, expect, it } from "vitest";

import { ConnectorProviderError } from "../runtime/oauth.js";
import {
	BUSINESS_CONNECTOR_TOOL_REFS,
	createBusinessConnectorTools,
} from "../providers/business/tools.js";
import {
	executeConnectorRead,
	privateConnectorAudit,
} from "../runtime/read-support.js";
import {
	createGitHubTools,
	GITHUB_TOOL_REFS,
} from "../plugins/oho/github/src/tools.js";
import {
	createGoogleWorkspaceTools,
	GOOGLE_WORKSPACE_TOOL_REFS,
} from "../providers/google-workspace/tools.js";
import {
	createFeishuTools,
	createLarkTools,
	FEISHU_TOOL_REFS,
	LARK_TOOL_REFS,
} from "../providers/lark/tools.js";
import {
	createNotionTools,
	NOTION_TOOL_REFS,
} from "../plugins/oho/notion/src/tools.js";
import {
	createSlackTools,
	SLACK_TOOL_REFS,
} from "../plugins/oho/slack/src/tools.js";
import { ToolImplementationError } from "../runtime/tool.js";

describe("collaboration connector tools", () => {
	it("match the catalog and isolate Slack publishing behind a high-risk proposal", () => {
		const refs = {
			...GITHUB_TOOL_REFS,
			...SLACK_TOOL_REFS,
			...NOTION_TOOL_REFS,
			...FEISHU_TOOL_REFS,
			...LARK_TOOL_REFS,
			...GOOGLE_WORKSPACE_TOOL_REFS,
			...BUSINESS_CONNECTOR_TOOL_REFS,
		};
		expect(Object.keys(refs)).toHaveLength(47);

		const tools = [
			...createGitHubTools(service),
			...createSlackTools(service, unavailableProposals),
			...createNotionTools(service),
			...createFeishuTools(service),
			...createLarkTools(service),
			...createGoogleWorkspaceTools(service),
			...createBusinessConnectorTools(service),
		];
		expect(tools).toHaveLength(47);
		const slackSend = tools.find(
			(tool) => tool.manifest.id === "slack.message.send",
		);
		expect(slackSend?.manifest).toMatchObject({
			risk: "high",
			sideEffect: "irreversible",
			network: "restricted",
		});
		for (const tool of tools.filter((candidate) => candidate !== slackSend)) {
			expect(tool.manifest).toMatchObject({
				sideEffect: "none",
				network: "restricted",
				executionMode: "sequential",
			});
			expect(tool.manifest.maxCallsPerRun).toBeGreaterThan(0);
			expect(tool.manifest.timeoutMs).toBe(20_000);
		}
	});

	it("rejects unknown fields and provider-specific limit overflow", () => {
		const [github] = createGitHubTools(service);
		const githubTools = createGitHubTools(service);
		const [slackChannels, slackMessages, slackSend] = createSlackTools(
			service,
			unavailableProposals,
		);
		const [notionSearch, notionRead] = createNotionTools(service);
		const [feishu] = createFeishuTools(service);
		const [lark] = createLarkTools(service);
		const [calendar, drive, sheets] = createGoogleWorkspaceTools(service);
		const [linear, stripe] = createBusinessConnectorTools(service);
		expect(github?.inputValidator.safeParse({ limit: 31 }).success).toBe(false);
		expect(
			githubTools
				.find((tool) => tool.manifest.id === "github.repository.file.read")
				?.inputValidator.safeParse({
					owner: "openai",
					repository: "example",
					path: "../secret",
				}).success,
		).toBe(false);
		expect(
			githubTools
				.find((tool) => tool.manifest.id === "github.issue.read")
				?.inputValidator.safeParse({
					owner: "openai",
					repository: "example",
					number: 0,
				}).success,
		).toBe(false);
		expect(
			slackChannels?.inputValidator.safeParse({ limit: 10, cursor: "hidden" })
				.success,
		).toBe(false);
		expect(
			slackMessages?.inputValidator.safeParse({ channelId: "C1", limit: 16 })
				.success,
		).toBe(false);
		expect(
			slackSend?.inputValidator.safeParse({
				channelId: "C1",
				text: "",
			}).success,
		).toBe(false);
		expect(
			slackSend?.inputValidator.safeParse({
				channelId: "C1",
				text: "hello",
				webhook: "hidden",
			}).success,
		).toBe(false);
		expect(
			notionSearch?.inputValidator.safeParse({ query: "", limit: 10 }).success,
		).toBe(false);
		expect(
			notionRead?.inputValidator.safeParse({ pageId: "page", depth: 2 })
				.success,
		).toBe(false);
		expect(lark?.inputValidator.safeParse({ limit: 51 }).success).toBe(false);
		expect(feishu?.inputValidator.safeParse({ limit: 51 }).success).toBe(false);
		expect(
			calendar?.inputValidator.safeParse({
				timeMin: "2026-08-13T10:00:00+08:00",
				timeMax: "2026-08-13T09:00:00+08:00",
			}).success,
		).toBe(false);
		expect(
			drive?.inputValidator.safeParse({ query: "", limit: 10 }).success,
		).toBe(false);
		expect(
			sheets?.inputValidator.safeParse({
				spreadsheetId: "sheet",
				range: "A1:B2",
				unexpected: true,
			}).success,
		).toBe(false);
		expect(linear?.inputValidator.safeParse({ limit: 51 }).success).toBe(false);
		expect(
			stripe?.inputValidator.safeParse({ limit: 20, secret: "hidden" }).success,
		).toBe(false);
	});

	it("redacts private content from durable audit projections", () => {
		const audit = privateConnectorAudit("notion.page.read", {
			pageId: "page-1",
			textBytes: 2048,
		});
		expect(audit).toEqual({
			kind: "notion.page.read",
			privatePayloadRedacted: true,
			pageId: "page-1",
			textBytes: 2048,
		});
		expect(JSON.stringify(audit)).not.toContain("page body");
	});

	it("normalizes authentication, rate-limit, provider, and timeout failures", async () => {
		const cases = [
			{
				error: new ConnectorProviderError(
					"slack",
					"invalid_auth",
					401,
					"invalid",
				),
				code: "auth_required",
				retryable: false,
			},
			{
				error: new ConnectorProviderError(
					"slack",
					"rate_limited",
					429,
					"slow down",
					2_000,
				),
				code: "rate_limited",
				retryable: true,
				details: { retryAfterMs: 2_000 },
			},
			{
				error: new ConnectorProviderError(
					"notion",
					"internal_server_error",
					503,
					"unavailable",
				),
				code: "provider_error",
				retryable: true,
			},
			{
				error: new DOMException("timed out", "TimeoutError"),
				code: "timeout",
				retryable: true,
			},
		] as const;

		for (const expected of cases) {
			const error = await executeConnectorRead("Provider", async () => {
				throw expected.error;
			}).catch((value: unknown) => value);
			expect(error).toBeInstanceOf(ToolImplementationError);
			expect(error).toMatchObject({
				code: expected.code,
				retryable: expected.retryable,
				...("details" in expected ? { details: expected.details } : {}),
			});
		}
	});
});
