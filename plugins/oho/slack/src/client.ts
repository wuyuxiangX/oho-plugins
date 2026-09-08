import { SLACK_SCOPES } from "../../../../runtime/provider-metadata.js";
import type {
	ConnectorOAuthCredential,
	ConnectorOAuthDriver,
} from "../../../../runtime/oauth.js";
import {
	ConnectorProviderError,
	connectorRequestSignal,
	oauthCredential,
	retryAfterMs,
} from "../../../../runtime/oauth.js";

const SLACK_API = "https://slack.com/api";
const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_USER_AGENT = "Oho/0.0.0";

type FetchLike = typeof fetch;

type SlackResponse = {
	ok?: boolean;
	error?: string;
	response_metadata?: { next_cursor?: string };
};

type SlackTokenResponse = SlackResponse & {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	authed_user?: {
		id?: string;
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		scope?: string;
	};
	team?: { id?: string; name?: string };
};

export type SlackChannel = {
	id: string;
	name: string;
	topic: string;
	purpose: string;
	isMember: boolean;
};

export type SlackMessage = {
	timestamp: string;
	userId?: string;
	text: string;
	threadTimestamp?: string;
};

type SlackChannelResource = {
	id?: string;
	name?: string;
	topic?: { value?: string };
	purpose?: { value?: string };
	is_member?: boolean;
};

type SlackMessageResource = {
	ts?: string;
	user?: string;
	text?: string;
	thread_ts?: string;
};

function mapSlackChannel(channel: SlackChannelResource): SlackChannel | null {
	if (!channel.id || !channel.name) return null;
	return {
		id: channel.id,
		name: channel.name.slice(0, 256),
		topic: (channel.topic?.value ?? "").slice(0, 2_048),
		purpose: (channel.purpose?.value ?? "").slice(0, 4_096),
		isMember: channel.is_member === true,
	};
}

function mapSlackMessage(message: SlackMessageResource): SlackMessage | null {
	if (!message.ts) return null;
	return {
		timestamp: message.ts,
		...(message.user ? { userId: message.user } : {}),
		text: (message.text ?? "").slice(0, 16 * 1_024),
		...(message.thread_ts ? { threadTimestamp: message.thread_ts } : {}),
	};
}

type SlackParsedResponse<T> = {
	body: T;
	providerRequestId?: string;
};

async function parseSlackResponse<T extends SlackResponse>(
	response: Response,
): Promise<SlackParsedResponse<T>> {
	const body = (await response.json().catch(() => ({}))) as T;
	if (!response.ok || body.ok !== true) {
		const code = body.error ?? `slack_http_${response.status}`;
		throw new ConnectorProviderError(
			"slack",
			code,
			response.ok &&
				["invalid_auth", "token_expired", "token_revoked"].includes(code)
				? 401
				: response.status,
			`Slack request failed: ${code}`,
			retryAfterMs(response),
		);
	}
	const providerRequestId = response.headers.get("x-slack-req-id")?.trim();
	return {
		body,
		...(providerRequestId ? { providerRequestId } : {}),
	};
}

async function slackJson<T extends SlackResponse>(
	response: Response,
): Promise<T> {
	return (await parseSlackResponse<T>(response)).body;
}

function slackHeaders(accessToken?: string): Record<string, string> {
	return {
		"User-Agent": SLACK_USER_AGENT,
		...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
	};
}

export class SlackClient implements ConnectorOAuthDriver {
	readonly connectorId = "slack" as const;
	readonly pkce = "S256" as const;
	readonly requiredScopes = SLACK_SCOPES;

	constructor(
		private readonly clientId?: string,
		private readonly fetchImpl: FetchLike = fetch,
		private readonly now: () => Date = () => new Date(),
	) {}

	get configured(): boolean {
		return Boolean(this.clientId);
	}

	authorizationUrl(input: {
		state: string;
		redirectUri: string;
		codeChallenge: string;
	}): URL {
		if (!this.clientId) throw new Error("slack_oauth_not_configured");
		const url = new URL(SLACK_AUTHORIZE_URL);
		url.searchParams.set("client_id", this.clientId);
		url.searchParams.set("redirect_uri", input.redirectUri);
		url.searchParams.set("user_scope", this.requiredScopes.join(","));
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
				code: input.code,
				redirect_uri: input.redirectUri,
				code_verifier: input.codeVerifier,
			},
			input.signal,
		);
		const credential = this.toCredential(token);
		return {
			credential,
			account:
				token.team?.id && token.team.name
					? { id: token.team.id, label: token.team.name }
					: await this.getAccount(credential.accessToken, input.signal),
		};
	}

	async refreshToken(
		credential: {
			refreshToken?: string;
			scopes: string[];
		},
		signal?: AbortSignal,
	) {
		if (!credential.refreshToken) {
			throw new ConnectorProviderError(
				"slack",
				"refresh_token_missing",
				401,
				"Slack refresh token is missing",
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
		const response = await this.fetchImpl(`${SLACK_API}/auth.test`, {
			method: "POST",
			headers: slackHeaders(accessToken),
			signal: connectorRequestSignal(signal),
		});
		const body = await slackJson<
			SlackResponse & { team_id?: string; team?: string; url?: string }
		>(response);
		if (!body.team_id) {
			throw new ConnectorProviderError(
				"slack",
				"workspace_identity_missing",
				502,
				"Slack did not return a workspace identity",
			);
		}
		return {
			id: body.team_id,
			label: body.team ?? body.url ?? body.team_id,
		};
	}

	async listChannels(
		accessToken: string,
		limit: number,
		signal?: AbortSignal,
	): Promise<SlackChannel[]> {
		const body = await this.api<
			SlackResponse & {
				channels?: SlackChannelResource[];
			}
		>(
			accessToken,
			"conversations.list",
			{
				types: "public_channel",
				exclude_archived: "true",
				limit: String(limit),
			},
			signal,
		);
		return (body.channels ?? []).flatMap((channel) => {
			const mapped = mapSlackChannel(channel);
			return mapped ? [mapped] : [];
		});
	}

	async getChannel(
		accessToken: string,
		channelId: string,
		signal?: AbortSignal,
	): Promise<SlackChannel> {
		const body = await this.api<
			SlackResponse & {
				channel?: SlackChannelResource;
			}
		>(accessToken, "conversations.info", { channel: channelId }, signal);
		const channel = body.channel ? mapSlackChannel(body.channel) : null;
		if (!channel) {
			throw new ConnectorProviderError(
				"slack",
				"channel_identity_missing",
				502,
				"Slack did not return the requested channel identity",
			);
		}
		return channel;
	}

	async readChannelMessages(
		accessToken: string,
		channelId: string,
		limit: number,
		signal?: AbortSignal,
	): Promise<SlackMessage[]> {
		const body = await this.api<
			SlackResponse & {
				messages?: SlackMessageResource[];
			}
		>(
			accessToken,
			"conversations.history",
			{
				channel: channelId,
				limit: String(Math.min(limit, 15)),
			},
			signal,
		);
		return (body.messages ?? []).flatMap((message) => {
			const mapped = mapSlackMessage(message);
			return mapped ? [mapped] : [];
		});
	}

	async readThreadReplies(
		accessToken: string,
		input: {
			channelId: string;
			threadTimestamp: string;
			limit: number;
			cursor?: string;
		},
		signal?: AbortSignal,
	): Promise<{ messages: SlackMessage[]; nextCursor?: string }> {
		const body = await this.api<
			SlackResponse & {
				messages?: SlackMessageResource[];
			}
		>(
			accessToken,
			"conversations.replies",
			{
				channel: input.channelId,
				ts: input.threadTimestamp,
				limit: String(Math.min(input.limit, 15)),
				...(input.cursor ? { cursor: input.cursor } : {}),
			},
			signal,
		);
		const messages = (body.messages ?? []).flatMap((message) => {
			const mapped = mapSlackMessage(message);
			return mapped ? [mapped] : [];
		});
		const nextCursor = body.response_metadata?.next_cursor?.trim();
		return {
			messages,
			...(nextCursor ? { nextCursor } : {}),
		};
	}

	async postMessage(
		accessToken: string,
		input: { channelId: string; text: string; clientMessageId: string },
		signal?: AbortSignal,
	): Promise<{
		id: string;
		resourceId: string;
		providerRequestId?: string;
		channelId: string;
		timestamp: string;
	}> {
		const { body, providerRequestId } = await this.apiResponse<
			SlackResponse & { channel?: string; ts?: string }
		>(
			accessToken,
			"chat.postMessage",
			{
				channel: input.channelId,
				text: input.text,
				client_msg_id: input.clientMessageId,
				mrkdwn: "false",
				link_names: "false",
				unfurl_links: "false",
				unfurl_media: "false",
			},
			signal,
		);
		if (!body.channel || !body.ts) {
			throw new ConnectorProviderError(
				"slack",
				"message_identity_missing",
				502,
				"Slack did not return the sent message identity",
			);
		}
		const resourceId = `${body.channel}:${body.ts}`;
		return {
			id: resourceId,
			resourceId,
			...(providerRequestId ? { providerRequestId } : {}),
			channelId: body.channel,
			timestamp: body.ts,
		};
	}

	async revokeCredential(
		credential: ConnectorOAuthCredential,
		signal?: AbortSignal,
	): Promise<void> {
		await this.api(credential.accessToken, "auth.revoke", {}, signal);
	}

	private async api<T extends SlackResponse>(
		accessToken: string,
		method: string,
		params: Record<string, string>,
		signal?: AbortSignal,
	): Promise<T> {
		return (await this.apiResponse<T>(accessToken, method, params, signal))
			.body;
	}

	private async apiResponse<T extends SlackResponse>(
		accessToken: string,
		method: string,
		params: Record<string, string>,
		signal?: AbortSignal,
	): Promise<SlackParsedResponse<T>> {
		const response = await this.fetchImpl(`${SLACK_API}/${method}`, {
			method: "POST",
			headers: {
				...slackHeaders(accessToken),
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(params),
			signal: connectorRequestSignal(signal),
		});
		return parseSlackResponse<T>(response);
	}

	private async tokenRequest(
		values: Record<string, string>,
		signal?: AbortSignal,
	): Promise<SlackTokenResponse> {
		if (!this.clientId) {
			throw new Error("slack_oauth_not_configured");
		}
		const response = await this.fetchImpl(`${SLACK_API}/oauth.v2.access`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"User-Agent": SLACK_USER_AGENT,
			},
			body: new URLSearchParams({ client_id: this.clientId, ...values }),
			signal: connectorRequestSignal(signal),
		});
		const body = await slackJson<SlackTokenResponse>(response);
		if (!body.authed_user?.access_token && !body.access_token) {
			throw new ConnectorProviderError(
				"slack",
				"access_token_missing",
				502,
				"Slack did not return an access token",
			);
		}
		return body;
	}

	private toCredential(
		token: SlackTokenResponse,
		fallbackScopes: readonly string[] = [],
	) {
		const granted = token.authed_user?.access_token ? token.authed_user : token;
		return oauthCredential({
			connectorId: this.connectorId,
			accessToken: granted.access_token as string,
			refreshToken: granted.refresh_token,
			expiresIn: granted.expires_in,
			scopes: granted.scope
				? granted.scope
						.split(",")
						.map((scope) => scope.trim())
						.filter(Boolean)
				: fallbackScopes,
			now: this.now(),
		});
	}
}
