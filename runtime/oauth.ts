import type { ConnectorId } from "./provider-metadata.js";

export type ConnectorOAuthCredential = {
	schemaVersion: "connector.oauth.v1";
	connectorId: ConnectorId;
	accessToken: string;
	refreshToken?: string;
	expiresAt?: string;
	refreshTokenExpiresAt?: string;
	scopes: string[];
};

export type ConnectorOAuthAccount = {
	id: string;
	label: string;
};

export type ConnectorOAuthGrant = {
	credential: ConnectorOAuthCredential;
	account?: ConnectorOAuthAccount;
};

export type OAuthAuthorizationInput = {
	state: string;
	redirectUri: string;
	codeChallenge: string;
};

export type OAuthExchangeInput = {
	code: string;
	codeVerifier: string;
	redirectUri: string;
	signal?: AbortSignal;
};

export interface ConnectorOAuthDriver {
	readonly connectorId: ConnectorId;
	readonly configured: boolean;
	readonly pkce: "S256" | "unsupported";
	readonly requiredScopes: readonly string[];
	authorizationUrl(input: OAuthAuthorizationInput): URL;
	exchangeCode(input: OAuthExchangeInput): Promise<ConnectorOAuthGrant>;
	refreshToken?(
		credential: ConnectorOAuthCredential,
		signal?: AbortSignal,
	): Promise<ConnectorOAuthCredential>;
	getAccount(
		accessToken: string,
		signal?: AbortSignal,
	): Promise<ConnectorOAuthAccount>;
	revokeCredential?(
		credential: ConnectorOAuthCredential,
		signal?: AbortSignal,
	): Promise<void>;
}

export class ConnectorProviderError extends Error {
	constructor(
		readonly provider: string,
		readonly code: string,
		readonly status: number,
		message: string,
		readonly retryAfterMs?: number,
	) {
		super(message);
		this.name = "ConnectorProviderError";
	}
}

export function connectorRequestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(15_000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function retryAfterMs(response: Response): number | undefined {
	const value = response.headers.get("Retry-After");
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.ceil(seconds * 1_000);
	}
	const delay = Date.parse(value) - Date.now();
	return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

export function oauthCredential(input: {
	connectorId: ConnectorId;
	accessToken: string;
	refreshToken?: string | null;
	expiresIn?: number;
	refreshTokenExpiresIn?: number;
	scopes?: readonly string[];
	now?: Date;
}): ConnectorOAuthCredential {
	const now = input.now ?? new Date();
	return {
		schemaVersion: "connector.oauth.v1",
		connectorId: input.connectorId,
		accessToken: input.accessToken,
		...(input.refreshToken ? { refreshToken: input.refreshToken } : {}),
		...(input.expiresIn
			? {
					expiresAt: new Date(
						now.getTime() + input.expiresIn * 1_000,
					).toISOString(),
				}
			: {}),
		...(input.refreshTokenExpiresIn
			? {
					refreshTokenExpiresAt: new Date(
						now.getTime() + input.refreshTokenExpiresIn * 1_000,
					).toISOString(),
				}
			: {}),
		scopes: [...(input.scopes ?? [])],
	};
}
