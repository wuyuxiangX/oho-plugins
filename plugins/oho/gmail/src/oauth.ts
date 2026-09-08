import {
	GMAIL_CONNECTOR_ID,
	GMAIL_SCOPES,
} from "../../../../runtime/provider-metadata.js";
import type {
	ConnectorOAuthCredential,
	ConnectorOAuthDriver,
} from "../../../../runtime/oauth.js";
import type { GmailClient } from "./client.js";

export class GmailOAuthDriver implements ConnectorOAuthDriver {
	readonly connectorId = GMAIL_CONNECTOR_ID;
	readonly pkce = "S256" as const;
	readonly requiredScopes = GMAIL_SCOPES;

	constructor(
		private readonly gmail: GmailClient,
		private readonly clientId?: string,
		private readonly clientSecret?: string,
	) {}

	get configured(): boolean {
		return Boolean(this.clientId && this.clientSecret);
	}

	authorizationUrl(input: {
		state: string;
		redirectUri: string;
		codeChallenge: string;
	}): URL {
		if (!this.clientId) throw new Error("gmail_oauth_not_configured");
		const authorization = new URL(
			"https://accounts.google.com/o/oauth2/v2/auth",
		);
		authorization.searchParams.set("client_id", this.clientId);
		authorization.searchParams.set("redirect_uri", input.redirectUri);
		authorization.searchParams.set("response_type", "code");
		authorization.searchParams.set("scope", GMAIL_SCOPES.join(" "));
		authorization.searchParams.set("access_type", "offline");
		authorization.searchParams.set("prompt", "consent");
		authorization.searchParams.set("include_granted_scopes", "false");
		authorization.searchParams.set("state", input.state);
		authorization.searchParams.set("code_challenge", input.codeChallenge);
		authorization.searchParams.set("code_challenge_method", "S256");
		return authorization;
	}

	async exchangeCode(input: {
		code: string;
		codeVerifier: string;
		redirectUri: string;
		signal?: AbortSignal;
	}) {
		if (!this.clientId || !this.clientSecret) {
			throw new Error("gmail_oauth_not_configured");
		}
		const token = await this.gmail.exchangeCode({
			clientId: this.clientId,
			clientSecret: this.clientSecret,
			code: input.code,
			codeVerifier: input.codeVerifier,
			redirectUri: input.redirectUri,
			signal: input.signal,
		});
		return {
			credential: {
				schemaVersion: "connector.oauth.v1" as const,
				connectorId: this.connectorId,
				accessToken: token.accessToken,
				refreshToken: token.refreshToken,
				expiresAt: token.expiresAt,
				scopes: token.scope,
			},
			account: await this.getAccount(token.accessToken, input.signal),
		};
	}

	async refreshToken(
		credential: ConnectorOAuthCredential,
		signal?: AbortSignal,
	): Promise<ConnectorOAuthCredential> {
		if (!this.clientId || !this.clientSecret || !credential.refreshToken) {
			throw new Error("gmail_oauth_refresh_unavailable");
		}
		const refreshed = await this.gmail.refreshToken({
			clientId: this.clientId,
			clientSecret: this.clientSecret,
			refreshToken: credential.refreshToken,
			signal,
		});
		return {
			...credential,
			accessToken: refreshed.accessToken,
			expiresAt: refreshed.expiresAt,
		};
	}

	async getAccount(accessToken: string, signal?: AbortSignal) {
		const profile = await this.gmail.getProfile(accessToken, signal);
		return { id: profile.emailAddress, label: profile.emailAddress };
	}

	async revokeCredential(credential: ConnectorOAuthCredential): Promise<void> {
		await this.gmail.revokeToken(
			credential.refreshToken ?? credential.accessToken,
		);
	}
}
