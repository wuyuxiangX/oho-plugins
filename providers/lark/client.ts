import { LARK_SCOPES } from "../../runtime/provider-metadata.js";
import type { ConnectorOAuthDriver } from "../../runtime/oauth.js";
import {
	ConnectorProviderError,
	connectorRequestSignal,
	oauthCredential,
	retryAfterMs,
} from "../../runtime/oauth.js";

const LARK_USER_AGENT = "Oho/0.0.0";

export type LarkRegion = "feishu" | "lark";

const LARK_REGIONS = {
	feishu: {
		api: "https://open.feishu.cn/open-apis",
		authorize: "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
	},
	lark: {
		api: "https://open.larksuite.com/open-apis",
		authorize: "https://accounts.larksuite.com/open-apis/authen/v1/authorize",
	},
} as const;

type FetchLike = typeof fetch;

type LarkEnvelope<T> = {
	code?: number;
	msg?: string;
	data?: T;
};

type LarkTokenResponse = {
	code?: number;
	error?: string;
	error_description?: string;
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	refresh_token_expires_in?: number;
	scope?: string;
};

export type LarkTask = {
	id: string;
	summary: string;
	description: string;
	dueAt?: string;
	completedAt?: string;
};

type LarkTaskResource = {
	guid?: string;
	summary?: string;
	description?: string;
	due?: { timestamp?: string };
	completed_at?: string;
};

function mapTask(task: LarkTaskResource): LarkTask | null {
	if (!task.guid) return null;
	return {
		id: task.guid,
		summary: (task.summary ?? "").slice(0, 1_024),
		description: (task.description ?? "").slice(0, 4_096),
		...(task.due?.timestamp ? { dueAt: task.due.timestamp } : {}),
		...(task.completed_at ? { completedAt: task.completed_at } : {}),
	};
}

async function larkJson<T>(
	response: Response,
	connectorId: LarkRegion,
): Promise<T> {
	const body = (await response.json().catch(() => ({}))) as {
		code?: number;
		msg?: string;
		error?: string;
		error_description?: string;
	};
	if (!response.ok || (typeof body.code === "number" && body.code !== 0)) {
		const code =
			body.error ?? String(body.code ?? `lark_http_${response.status}`);
		throw new ConnectorProviderError(
			connectorId,
			code,
			response.status === 200 && ["20005", "20024"].includes(code)
				? 401
				: response.status,
			body.error_description ?? body.msg ?? "Lark request failed",
			retryAfterMs(response),
		);
	}
	return body as T;
}

function larkHeaders(accessToken?: string): Record<string, string> {
	return {
		Accept: "application/json",
		"Content-Type": "application/json; charset=utf-8",
		"User-Agent": LARK_USER_AGENT,
		...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
	};
}

export class LarkClient implements ConnectorOAuthDriver {
	readonly connectorId: LarkRegion;
	readonly pkce = "S256" as const;
	readonly requiredScopes = LARK_SCOPES;
	private readonly endpoints: (typeof LARK_REGIONS)[LarkRegion];

	constructor(
		private readonly clientId?: string,
		private readonly clientSecret?: string,
		private readonly fetchImpl: FetchLike = fetch,
		private readonly now: () => Date = () => new Date(),
		region: LarkRegion = "lark",
	) {
		this.connectorId = region;
		this.endpoints = LARK_REGIONS[region];
	}

	get configured(): boolean {
		return Boolean(this.clientId && this.clientSecret);
	}

	authorizationUrl(input: {
		state: string;
		redirectUri: string;
		codeChallenge: string;
	}): URL {
		if (!this.clientId) {
			throw new Error(`${this.connectorId}_oauth_not_configured`);
		}
		const url = new URL(this.endpoints.authorize);
		url.searchParams.set("client_id", this.clientId);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("redirect_uri", input.redirectUri);
		url.searchParams.set("scope", this.requiredScopes.join(" "));
		url.searchParams.set("prompt", "consent");
		url.searchParams.set("state", input.state);
		url.searchParams.set("code_challenge", input.codeChallenge);
		url.searchParams.set("code_challenge_method", "S256");
		return url;
	}

	async exchangeCode(input: {
		code: string;
		codeVerifier: string;
		redirectUri: string;
		signal?: AbortSignal;
	}) {
		const token = await this.tokenRequest(
			{
				grant_type: "authorization_code",
				code: input.code,
				redirect_uri: input.redirectUri,
				code_verifier: input.codeVerifier,
				scope: this.requiredScopes.join(" "),
			},
			input.signal,
		);
		const credential = this.toCredential(token);
		return {
			credential,
			account: await this.getAccount(credential.accessToken, input.signal),
		};
	}

	async refreshToken(
		credential: { refreshToken?: string; scopes: string[] },
		signal?: AbortSignal,
	) {
		if (!credential.refreshToken) {
			throw new ConnectorProviderError(
				this.connectorId,
				"refresh_token_missing",
				401,
				"Lark refresh token is missing",
			);
		}
		return this.toCredential(
			await this.tokenRequest(
				{
					grant_type: "refresh_token",
					refresh_token: credential.refreshToken,
				},
				signal,
			),
			credential.scopes,
		);
	}

	async getAccount(accessToken: string, signal?: AbortSignal) {
		const response = await this.fetchImpl(
			`${this.endpoints.api}/authen/v1/user_info`,
			{
				headers: larkHeaders(accessToken),
				signal: connectorRequestSignal(signal),
			},
		);
		const body = await larkJson<
			LarkEnvelope<{ open_id?: string; name?: string; tenant_key?: string }>
		>(response, this.connectorId);
		if (!body.data?.open_id) {
			throw new ConnectorProviderError(
				this.connectorId,
				"user_identity_missing",
				502,
				"Lark did not return a user identity",
			);
		}
		return {
			id: body.data.open_id,
			label: body.data.name ?? body.data.open_id,
		};
	}

	async listTasks(
		accessToken: string,
		limit: number,
		pageToken: string | undefined,
		signal?: AbortSignal,
	): Promise<{ tasks: LarkTask[]; nextPageToken?: string }> {
		const url = new URL(`${this.endpoints.api}/task/v2/tasks`);
		url.searchParams.set("page_size", String(limit));
		url.searchParams.set("user_id_type", "open_id");
		if (pageToken) url.searchParams.set("page_token", pageToken);
		const response = await this.fetchImpl(url, {
			headers: larkHeaders(accessToken),
			signal: connectorRequestSignal(signal),
		});
		const body = await larkJson<
			LarkEnvelope<{
				items?: LarkTaskResource[];
				page_token?: string;
				has_more?: boolean;
			}>
		>(response, this.connectorId);
		return {
			tasks: (body.data?.items ?? []).flatMap((task) => {
				const mapped = mapTask(task);
				return mapped ? [mapped] : [];
			}),
			...(body.data?.has_more && body.data.page_token
				? { nextPageToken: body.data.page_token }
				: {}),
		};
	}

	async getTask(
		accessToken: string,
		taskId: string,
		signal?: AbortSignal,
	): Promise<LarkTask> {
		const url = new URL(
			`${this.endpoints.api}/task/v2/tasks/${encodeURIComponent(taskId)}`,
		);
		url.searchParams.set("user_id_type", "open_id");
		const response = await this.fetchImpl(url, {
			headers: larkHeaders(accessToken),
			signal: connectorRequestSignal(signal),
		});
		const body = await larkJson<LarkEnvelope<{ task?: LarkTaskResource }>>(
			response,
			this.connectorId,
		);
		const task = body.data?.task ? mapTask(body.data.task) : null;
		if (!task) {
			throw new ConnectorProviderError(
				this.connectorId,
				"task_identity_missing",
				502,
				"Feishu / Lark did not return the requested task identity",
			);
		}
		return task;
	}

	private async tokenRequest(
		body: Record<string, string>,
		signal?: AbortSignal,
	): Promise<LarkTokenResponse> {
		if (!this.clientId || !this.clientSecret) {
			throw new Error(`${this.connectorId}_oauth_not_configured`);
		}
		const response = await this.fetchImpl(
			`${this.endpoints.api}/authen/v2/oauth/token`,
			{
				method: "POST",
				headers: larkHeaders(),
				body: JSON.stringify({
					client_id: this.clientId,
					client_secret: this.clientSecret,
					...body,
				}),
				signal: connectorRequestSignal(signal),
			},
		);
		const token = await larkJson<LarkTokenResponse>(response, this.connectorId);
		if (!token.access_token) {
			throw new ConnectorProviderError(
				this.connectorId,
				"access_token_missing",
				502,
				"Lark did not return an access token",
			);
		}
		return token;
	}

	private toCredential(
		token: LarkTokenResponse,
		fallbackScopes: readonly string[] = [],
	) {
		return oauthCredential({
			connectorId: this.connectorId,
			accessToken: token.access_token as string,
			refreshToken: token.refresh_token,
			expiresIn: token.expires_in,
			refreshTokenExpiresIn: token.refresh_token_expires_in,
			scopes: token.scope
				? token.scope
						.split(" ")
						.map((scope) => scope.trim())
						.filter(Boolean)
				: fallbackScopes,
			now: this.now(),
		});
	}
}
