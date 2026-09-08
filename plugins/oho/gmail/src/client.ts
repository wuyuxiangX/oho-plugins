import { randomUUID } from "node:crypto";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LABELS = 100;

export type GmailTokenSet = {
	accessToken: string;
	refreshToken: string;
	expiresAt: string;
	scope: string[];
};

export type GmailMessageSnapshot = {
	id: string;
	threadId: string;
	messageId: string;
	from: string;
	to: string[];
	subject: string;
	date: string;
	body: string;
	bodyTruncated: boolean;
};

export type GmailDraftSnapshot = GmailMessageSnapshot & { draftId: string };

export type GmailLabel = {
	id: string;
	name: string;
	type: string;
};

export type GmailLabelPage = {
	labels: GmailLabel[];
	truncated: boolean;
};

export type GmailDraftSummary = {
	draftId: string;
	messageId: string;
	threadId: string;
	to: string[];
	subject: string;
	date: string;
};

type FetchLike = typeof fetch;

export class GmailApiError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		message: string,
		readonly retryAfterMs?: number,
	) {
		super(message);
		this.name = "GmailApiError";
	}
}

export function isGmailReauthorizationError(error: unknown): boolean {
	return (
		error instanceof GmailApiError &&
		(error.status === 401 ||
			error.code === "invalid_grant" ||
			error.code === "invalid_token")
	);
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(15_000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function jsonResponse<T>(response: Response): Promise<T> {
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as {
			error?:
				| string
				| {
						message?: string;
						status?: string;
						errors?: Array<{ reason?: string }>;
				  };
			error_description?: string;
		};
		const providerCode =
			typeof body.error === "string"
				? body.error
				: (body.error?.errors?.[0]?.reason ?? body.error?.status);
		const providerMessage =
			typeof body.error === "object" ? body.error.message : undefined;
		const retryAfter = response.headers.get("Retry-After");
		let retryAfterMs: number | undefined;
		if (retryAfter) {
			const seconds = Number(retryAfter);
			if (Number.isFinite(seconds) && seconds >= 0) {
				retryAfterMs = Math.ceil(seconds * 1_000);
			} else {
				const delay = Date.parse(retryAfter) - Date.now();
				if (Number.isFinite(delay) && delay > 0) retryAfterMs = delay;
			}
		}
		throw new GmailApiError(
			providerCode ?? `gmail_http_${response.status}`,
			response.status,
			providerMessage ??
				body.error_description ??
				`Gmail request failed (${response.status})`,
			retryAfterMs,
		);
	}
	if (response.status === 204) return undefined as T;
	return response.json() as Promise<T>;
}

async function mapWithConcurrency<T, TResult>(
	items: T[],
	concurrency: number,
	mapper: (item: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
	const results = new Array<TResult>(items.length);
	let nextIndex = 0;
	const worker = async () => {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			const item = items[index];
			if (item === undefined) continue;
			results[index] = await mapper(item, index);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
	);
	return results;
}

function decodeBase64Url(value: string | undefined): string {
	if (!value) return "";
	return Buffer.from(value, "base64url").toString("utf8");
}

type GmailPart = {
	mimeType?: string;
	headers?: Array<{ name: string; value: string }>;
	body?: { data?: string };
	parts?: GmailPart[];
};

type GmailMessage = {
	id: string;
	threadId: string;
	payload?: GmailPart;
};

function header(part: GmailPart | undefined, name: string): string {
	return (
		part?.headers?.find(
			(item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
		)?.value ?? ""
	);
}

function plainBody(part: GmailPart | undefined): string {
	if (!part) return "";
	if (part.mimeType === "text/plain" && part.body?.data) {
		return decodeBase64Url(part.body.data);
	}
	for (const child of part.parts ?? []) {
		const body = plainBody(child);
		if (body) return body;
	}
	return "";
}

function boundedBody(body: string): { body: string; truncated: boolean } {
	const bytes = Buffer.from(body, "utf8");
	if (bytes.length <= MAX_BODY_BYTES) return { body, truncated: false };
	return {
		body: bytes.subarray(0, MAX_BODY_BYTES).toString("utf8"),
		truncated: true,
	};
}

function splitAddresses(value: string): string[] {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

export function toMessageSnapshot(message: GmailMessage): GmailMessageSnapshot {
	const bounded = boundedBody(plainBody(message.payload));
	return {
		id: message.id,
		threadId: message.threadId,
		messageId: header(message.payload, "Message-ID"),
		from: header(message.payload, "From"),
		to: splitAddresses(header(message.payload, "To")),
		subject: header(message.payload, "Subject"),
		date: header(message.payload, "Date"),
		body: bounded.body,
		bodyTruncated: bounded.truncated,
	};
}

function encodeHeader(value: string): string {
	return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function rawMessage(input: {
	to: string[];
	subject: string;
	body: string;
	messageId: string;
}): string {
	const lines = [
		`To: ${input.to.join(", ")}`,
		`Subject: ${encodeHeader(input.subject)}`,
		`Message-ID: ${input.messageId}`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: 8bit",
		"",
		input.body,
	];
	return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

export class GmailClient {
	constructor(private readonly fetchImpl: FetchLike = fetch) {}

	async exchangeCode(input: {
		clientId: string;
		clientSecret: string;
		code: string;
		codeVerifier: string;
		redirectUri: string;
		signal?: AbortSignal;
	}): Promise<GmailTokenSet> {
		const response = await this.fetchImpl(GOOGLE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: input.clientId,
				client_secret: input.clientSecret,
				code: input.code,
				code_verifier: input.codeVerifier,
				grant_type: "authorization_code",
				redirect_uri: input.redirectUri,
			}),
			signal: requestSignal(input.signal),
		});
		const token = await jsonResponse<{
			access_token: string;
			refresh_token?: string;
			expires_in: number;
			scope?: string;
		}>(response);
		if (!token.refresh_token) {
			throw new GmailApiError(
				"gmail_refresh_token_missing",
				502,
				"Google did not return an offline refresh token",
			);
		}
		return {
			accessToken: token.access_token,
			refreshToken: token.refresh_token,
			expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
			scope: token.scope?.split(" ").filter(Boolean) ?? [],
		};
	}

	async refreshToken(input: {
		clientId: string;
		clientSecret: string;
		refreshToken: string;
		signal?: AbortSignal;
	}): Promise<Pick<GmailTokenSet, "accessToken" | "expiresAt">> {
		const response = await this.fetchImpl(GOOGLE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: input.clientId,
				client_secret: input.clientSecret,
				refresh_token: input.refreshToken,
				grant_type: "refresh_token",
			}),
			signal: requestSignal(input.signal),
		});
		const token = await jsonResponse<{
			access_token: string;
			expires_in: number;
		}>(response);
		return {
			accessToken: token.access_token,
			expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
		};
	}

	async revokeToken(token: string, signal?: AbortSignal): Promise<void> {
		const response = await this.fetchImpl(GOOGLE_REVOKE_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token }),
			signal: requestSignal(signal),
		});
		if (!response.ok) {
			throw new GmailApiError(
				`google_revoke_http_${response.status}`,
				response.status,
				"Google token revocation failed",
			);
		}
	}

	private async gmail<T>(
		accessToken: string,
		path: string,
		init: RequestInit = {},
	): Promise<T> {
		const response = await this.fetchImpl(`${GMAIL_API}${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				...(init.body ? { "Content-Type": "application/json" } : {}),
				...init.headers,
			},
			signal: requestSignal(init.signal ?? undefined),
		});
		return jsonResponse<T>(response);
	}

	getProfile(accessToken: string, signal?: AbortSignal) {
		return this.gmail<{ emailAddress: string }>(
			accessToken,
			"/users/me/profile",
			{ signal },
		);
	}

	async listLabels(
		accessToken: string,
		signal?: AbortSignal,
	): Promise<GmailLabelPage> {
		const result = await this.gmail<{
			labels?: Array<{
				id?: string;
				name?: string;
				type?: string;
			}>;
		}>(accessToken, "/users/me/labels", { signal });
		const source = result.labels ?? [];
		const labels = source.slice(0, MAX_LABELS).flatMap((label) =>
			label.id && label.name
				? [
						{
							id: label.id,
							name: label.name.slice(0, 256),
							type: (label.type ?? "").slice(0, 64),
						},
					]
				: [],
		);
		return { labels, truncated: source.length > MAX_LABELS };
	}

	async listDrafts(
		accessToken: string,
		limit: number,
		signal?: AbortSignal,
	): Promise<GmailDraftSummary[]> {
		const params = new URLSearchParams({ maxResults: String(limit) });
		const listed = await this.gmail<{ drafts?: Array<{ id?: string }> }>(
			accessToken,
			`/users/me/drafts?${params.toString()}`,
			{ signal },
		);
		const draftIds = (listed.drafts ?? [])
			.flatMap((draft) => (draft.id ? [draft.id] : []))
			.slice(0, limit);
		return mapWithConcurrency(draftIds, 4, async (draftId) => {
			const draft = await this.gmail<{ id: string; message: GmailMessage }>(
				accessToken,
				`/users/me/drafts/${encodeURIComponent(draftId)}?format=metadata&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`,
				{ signal },
			);
			const message = toMessageSnapshot(draft.message);
			return {
				draftId: draft.id,
				messageId: message.id,
				threadId: message.threadId,
				to: message.to,
				subject: message.subject.slice(0, 998),
				date: message.date,
			};
		});
	}

	async searchThreads(
		accessToken: string,
		query: string,
		limit: number,
		signal?: AbortSignal,
	): Promise<Array<{ id: string; messages: GmailMessageSnapshot[] }>> {
		const params = new URLSearchParams({ q: query, maxResults: String(limit) });
		const listed = await this.gmail<{ threads?: Array<{ id: string }> }>(
			accessToken,
			`/users/me/threads?${params.toString()}`,
			{ signal },
		);
		return mapWithConcurrency(
			(listed.threads ?? []).slice(0, limit),
			4,
			async ({ id }) => {
				const thread = await this.gmail<{ messages?: GmailMessage[] }>(
					accessToken,
					`/users/me/threads/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`,
					{ signal },
				);
				return {
					id,
					messages: (thread.messages ?? []).slice(-3).map(toMessageSnapshot),
				};
			},
		);
	}

	async readThread(
		accessToken: string,
		threadId: string,
		signal?: AbortSignal,
	): Promise<GmailMessageSnapshot[]> {
		const thread = await this.gmail<{ messages?: GmailMessage[] }>(
			accessToken,
			`/users/me/threads/${encodeURIComponent(threadId)}?format=full`,
			{ signal },
		);
		return (thread.messages ?? []).slice(-20).map(toMessageSnapshot);
	}

	async getDraft(
		accessToken: string,
		draftId: string,
		signal?: AbortSignal,
	): Promise<GmailDraftSnapshot> {
		const draft = await this.gmail<{ id: string; message: GmailMessage }>(
			accessToken,
			`/users/me/drafts/${encodeURIComponent(draftId)}?format=full`,
			{ signal },
		);
		return { draftId: draft.id, ...toMessageSnapshot(draft.message) };
	}

	async upsertDraft(
		accessToken: string,
		input: { draftId?: string; to: string[]; subject: string; body: string },
		signal?: AbortSignal,
	): Promise<GmailDraftSnapshot> {
		let messageId = `<oho-${randomUUID()}@oho.local>`;
		if (input.draftId) {
			const current = await this.getDraft(accessToken, input.draftId, signal);
			if (current.messageId) messageId = current.messageId;
		}
		const raw = rawMessage({ ...input, messageId });
		const path = input.draftId
			? `/users/me/drafts/${encodeURIComponent(input.draftId)}`
			: "/users/me/drafts";
		const saved = await this.gmail<{ id: string }>(accessToken, path, {
			method: input.draftId ? "PUT" : "POST",
			body: JSON.stringify({ message: { raw } }),
			signal,
		});
		return this.getDraft(accessToken, saved.id, signal);
	}

	async sendMessage(
		accessToken: string,
		input: { to: string[]; subject: string; body: string; messageId: string },
		signal?: AbortSignal,
	): Promise<{ id: string; threadId: string }> {
		return this.gmail(accessToken, "/users/me/messages/send", {
			method: "POST",
			body: JSON.stringify({ raw: rawMessage(input) }),
			signal,
		});
	}

	async deleteDraft(
		accessToken: string,
		draftId: string,
		signal?: AbortSignal,
	): Promise<void> {
		await this.gmail<void>(
			accessToken,
			`/users/me/drafts/${encodeURIComponent(draftId)}`,
			{ method: "DELETE", signal },
		);
	}

	async findSentByMessageId(
		accessToken: string,
		messageId: string,
		signal?: AbortSignal,
	): Promise<string | null> {
		if (!messageId) return null;
		const query = `in:sent rfc822msgid:${messageId.replace(/[<>]/g, "")}`;
		const params = new URLSearchParams({ q: query, maxResults: "1" });
		const result = await this.gmail<{ messages?: Array<{ id: string }> }>(
			accessToken,
			`/users/me/messages?${params.toString()}`,
			{ signal },
		);
		return result.messages?.[0]?.id ?? null;
	}
}
