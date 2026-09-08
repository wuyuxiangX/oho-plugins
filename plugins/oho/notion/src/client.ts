import { NOTION_SCOPES } from "../../../../runtime/provider-metadata.js";
import type { ConnectorOAuthDriver } from "../../../../runtime/oauth.js";
import {
	ConnectorProviderError,
	connectorRequestSignal,
	oauthCredential,
	retryAfterMs,
} from "../../../../runtime/oauth.js";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
const NOTION_VERSION = "2026-03-11";
const NOTION_USER_AGENT = "Oho/0.0.0";
const MAX_PAGE_TEXT_BYTES = 64 * 1024;

type FetchLike = typeof fetch;

type NotionTokenResponse = {
	access_token?: string;
	refresh_token?: string | null;
	bot_id?: string;
	workspace_id?: string;
	workspace_name?: string | null;
	message?: string;
	code?: string;
};

type RichText = Array<{ plain_text?: string }>;

type NotionPage = {
	id?: string;
	url?: string;
	last_edited_time?: string;
	properties?: Record<
		string,
		{ type?: string; title?: RichText; rich_text?: RichText }
	>;
};

type NotionBlock = {
	id?: string;
	type?: string;
	has_children?: boolean;
	[key: string]: unknown;
};

export type NotionPageSummary = {
	id: string;
	title: string;
	url: string;
	lastEditedAt: string;
};

export type NotionPageContent = NotionPageSummary & {
	text: string;
	truncated: boolean;
	hasMore: boolean;
};

export type NotionPageMetadata = NotionPageSummary & {
	properties: Array<{ name: string; type: string; value: string }>;
};

export type NotionBlockSummary = {
	id: string;
	type: string;
	hasChildren: boolean;
	text: string;
};

async function notionJson<T>(response: Response): Promise<T> {
	const body = (await response.json().catch(() => ({}))) as {
		code?: string;
		message?: string;
	};
	if (!response.ok) {
		throw new ConnectorProviderError(
			"notion",
			body.code ?? `notion_http_${response.status}`,
			response.status,
			body.message ?? `Notion request failed (${response.status})`,
			retryAfterMs(response),
		);
	}
	return body as T;
}

function notionHeaders(accessToken?: string): Record<string, string> {
	return {
		Accept: "application/json",
		"Content-Type": "application/json",
		"Notion-Version": NOTION_VERSION,
		"User-Agent": NOTION_USER_AGENT,
		...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
	};
}

function richText(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value
		.map((item) =>
			item && typeof item === "object" && "plain_text" in item
				? String(item.plain_text ?? "")
				: "",
		)
		.join("");
}

function pageTitle(page: NotionPage): string {
	for (const property of Object.values(page.properties ?? {})) {
		if (property.type === "title")
			return richText(property.title).slice(0, 2_000);
	}
	return "Untitled";
}

function pageSummary(page: NotionPage): NotionPageSummary | null {
	if (!page.id) return null;
	return {
		id: page.id,
		title: pageTitle(page),
		url: (page.url ?? "").slice(0, 2_048),
		lastEditedAt: page.last_edited_time ?? "",
	};
}

function blockText(block: NotionBlock): string {
	if (!block.type) return "";
	const value = block[block.type];
	if (!value || typeof value !== "object" || Array.isArray(value)) return "";
	const object = value as Record<string, unknown>;
	return richText(object.rich_text ?? object.caption);
}

function propertyText(property: Record<string, unknown>): string {
	const type = typeof property.type === "string" ? property.type : "";
	const value = property[type];
	if (type === "title" || type === "rich_text") return richText(value);
	if (type === "number" && typeof value === "number") return String(value);
	if (type === "checkbox" && typeof value === "boolean") return String(value);
	if (
		["url", "email", "phone_number"].includes(type) &&
		typeof value === "string"
	) {
		return value;
	}
	if (type === "select" || type === "status") {
		return value && typeof value === "object" && "name" in value
			? String(value.name ?? "")
			: "";
	}
	if (type === "multi_select" && Array.isArray(value)) {
		return value
			.map((item) =>
				item && typeof item === "object" && "name" in item
					? String(item.name ?? "")
					: "",
			)
			.filter(Boolean)
			.join(", ");
	}
	if (type === "date" && value && typeof value === "object") {
		const date = value as { start?: unknown; end?: unknown };
		return [date.start, date.end].filter(Boolean).map(String).join(" – ");
	}
	return "";
}

function truncateUtf8(bytes: Buffer, maximumBytes: number): string {
	let end = maximumBytes;
	while (end > 0) {
		const byte = bytes[end];
		if (byte === undefined || (byte & 0xc0) !== 0x80) break;
		end -= 1;
	}
	return bytes.subarray(0, end).toString("utf8");
}

export class NotionClient implements ConnectorOAuthDriver {
	readonly connectorId = "notion" as const;
	readonly pkce = "unsupported" as const;
	readonly requiredScopes = NOTION_SCOPES;

	constructor(
		private readonly clientId?: string,
		private readonly clientSecret?: string,
		private readonly fetchImpl: FetchLike = fetch,
	) {}

	get configured(): boolean {
		return Boolean(this.clientId && this.clientSecret);
	}

	authorizationUrl(input: { state: string; redirectUri: string }): URL {
		if (!this.clientId) throw new Error("notion_oauth_not_configured");
		const url = new URL(NOTION_AUTHORIZE_URL);
		url.searchParams.set("client_id", this.clientId);
		url.searchParams.set("redirect_uri", input.redirectUri);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("owner", "user");
		url.searchParams.set("state", input.state);
		return url;
	}

	async exchangeCode(input: {
		code: string;
		redirectUri: string;
		signal?: AbortSignal;
	}) {
		const token = await this.tokenRequest(
			{
				grant_type: "authorization_code",
				code: input.code,
				redirect_uri: input.redirectUri,
			},
			input.signal,
		);
		const credential = oauthCredential({
			connectorId: this.connectorId,
			accessToken: token.access_token as string,
			refreshToken: token.refresh_token,
			scopes: [],
		});
		return {
			credential,
			account: token.workspace_id
				? {
						id: token.workspace_id,
						label: token.workspace_name ?? token.workspace_id,
					}
				: await this.getAccount(credential.accessToken, input.signal),
		};
	}

	async refreshToken(
		credential: { refreshToken?: string },
		signal?: AbortSignal,
	) {
		if (!credential.refreshToken) {
			throw new ConnectorProviderError(
				"notion",
				"refresh_token_missing",
				401,
				"Notion refresh token is missing",
			);
		}
		const token = await this.tokenRequest(
			{
				grant_type: "refresh_token",
				refresh_token: credential.refreshToken,
			},
			signal,
		);
		return oauthCredential({
			connectorId: this.connectorId,
			accessToken: token.access_token as string,
			refreshToken: token.refresh_token ?? credential.refreshToken,
			scopes: [],
		});
	}

	async getAccount(accessToken: string, signal?: AbortSignal) {
		const response = await this.fetchImpl(`${NOTION_API}/users/me`, {
			headers: notionHeaders(accessToken),
			signal: connectorRequestSignal(signal),
		});
		const bot = await notionJson<{ id?: string; name?: string }>(response);
		if (!bot.id) {
			throw new ConnectorProviderError(
				"notion",
				"workspace_identity_missing",
				502,
				"Notion did not return a connection identity",
			);
		}
		return { id: bot.id, label: bot.name ?? bot.id };
	}

	async searchPages(
		accessToken: string,
		query: string,
		limit: number,
		signal?: AbortSignal,
	): Promise<NotionPageSummary[]> {
		const response = await this.fetchImpl(`${NOTION_API}/search`, {
			method: "POST",
			headers: notionHeaders(accessToken),
			body: JSON.stringify({
				query,
				filter: { property: "object", value: "page" },
				page_size: limit,
			}),
			signal: connectorRequestSignal(signal),
		});
		const body = await notionJson<{ results?: NotionPage[] }>(response);
		return (body.results ?? []).flatMap((page) => {
			const summary = pageSummary(page);
			return summary ? [summary] : [];
		});
	}

	async readPage(
		accessToken: string,
		pageId: string,
		signal?: AbortSignal,
	): Promise<NotionPageContent> {
		const [pageResponse, childrenResponse] = await Promise.all([
			this.fetchImpl(`${NOTION_API}/pages/${encodeURIComponent(pageId)}`, {
				headers: notionHeaders(accessToken),
				signal: connectorRequestSignal(signal),
			}),
			this.fetchImpl(
				`${NOTION_API}/blocks/${encodeURIComponent(pageId)}/children?page_size=100`,
				{
					headers: notionHeaders(accessToken),
					signal: connectorRequestSignal(signal),
				},
			),
		]);
		const page = await notionJson<NotionPage>(pageResponse);
		const children = await notionJson<{
			results?: NotionBlock[];
			has_more?: boolean;
		}>(childrenResponse);
		const summary = pageSummary(page);
		if (!summary) {
			throw new ConnectorProviderError(
				"notion",
				"page_identity_missing",
				502,
				"Notion did not return the requested page identity",
			);
		}
		const rawText = (children.results ?? [])
			.map(blockText)
			.filter(Boolean)
			.join("\n");
		const bytes = Buffer.from(rawText, "utf8");
		const truncated = bytes.length > MAX_PAGE_TEXT_BYTES;
		return {
			...summary,
			text: truncated ? truncateUtf8(bytes, MAX_PAGE_TEXT_BYTES) : rawText,
			truncated,
			hasMore: children.has_more === true,
		};
	}

	async readPageMetadata(
		accessToken: string,
		pageId: string,
		signal?: AbortSignal,
	): Promise<NotionPageMetadata> {
		const response = await this.fetchImpl(
			`${NOTION_API}/pages/${encodeURIComponent(pageId)}`,
			{
				headers: notionHeaders(accessToken),
				signal: connectorRequestSignal(signal),
			},
		);
		const page = await notionJson<NotionPage>(response);
		const summary = pageSummary(page);
		if (!summary) {
			throw new ConnectorProviderError(
				"notion",
				"page_identity_missing",
				502,
				"Notion did not return the requested page identity",
			);
		}
		return {
			...summary,
			properties: Object.entries(page.properties ?? {})
				.slice(0, 100)
				.map(([name, property]) => ({
					name: name.slice(0, 512),
					type: (property.type ?? "").slice(0, 128),
					value: propertyText(property as Record<string, unknown>).slice(
						0,
						4_096,
					),
				})),
		};
	}

	async listBlockChildren(
		accessToken: string,
		input: { blockId: string; limit: number; cursor?: string },
		signal?: AbortSignal,
	): Promise<{ blocks: NotionBlockSummary[]; nextCursor?: string }> {
		const url = new URL(
			`${NOTION_API}/blocks/${encodeURIComponent(input.blockId)}/children`,
		);
		url.searchParams.set("page_size", String(input.limit));
		if (input.cursor) url.searchParams.set("start_cursor", input.cursor);
		const response = await this.fetchImpl(url, {
			headers: notionHeaders(accessToken),
			signal: connectorRequestSignal(signal),
		});
		const body = await notionJson<{
			results?: NotionBlock[];
			has_more?: boolean;
			next_cursor?: string | null;
		}>(response);
		const nextCursor = body.has_more ? body.next_cursor?.trim() : undefined;
		return {
			blocks: (body.results ?? []).flatMap((block) =>
				block.id && block.type
					? [
							{
								id: block.id,
								type: block.type.slice(0, 128),
								hasChildren: block.has_children === true,
								text: blockText(block).slice(0, 16 * 1_024),
							},
						]
					: [],
			),
			...(nextCursor ? { nextCursor } : {}),
		};
	}

	private async tokenRequest(
		body: Record<string, string>,
		signal?: AbortSignal,
	): Promise<NotionTokenResponse> {
		if (!this.clientId || !this.clientSecret) {
			throw new Error("notion_oauth_not_configured");
		}
		const response = await this.fetchImpl(`${NOTION_API}/oauth/token`, {
			method: "POST",
			headers: {
				...notionHeaders(),
				Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
			},
			body: JSON.stringify(body),
			signal: connectorRequestSignal(signal),
		});
		const token = await notionJson<NotionTokenResponse>(response);
		if (!token.access_token) {
			throw new ConnectorProviderError(
				"notion",
				"access_token_missing",
				502,
				"Notion did not return an access token",
			);
		}
		return token;
	}
}
