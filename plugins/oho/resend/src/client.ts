const RESEND_API = "https://api.resend.com";
const RESEND_USER_AGENT = "Oho/0.0.0";

type FetchLike = typeof fetch;

export type ResendCredentialPermission = "sending_access" | "full_access";

export class ResendApiError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		message: string,
		readonly retryAfterMs?: number,
	) {
		super(message);
		this.name = "ResendApiError";
	}
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(15_000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function retryAfterMs(response: Response): number | undefined {
	const value = response.headers.get("Retry-After");
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.ceil(seconds * 1_000);
	}
	const delay = Date.parse(value) - Date.now();
	return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

async function providerError(response: Response): Promise<ResendApiError> {
	const body = (await response.json().catch(() => ({}))) as {
		name?: string;
		code?: string;
		message?: string;
	};
	return new ResendApiError(
		body.name ?? body.code ?? `resend_http_${response.status}`,
		response.status,
		body.message ?? `Resend request failed (${response.status})`,
		retryAfterMs(response),
	);
}

function headers(apiKey: string): Record<string, string> {
	return {
		Authorization: `Bearer ${apiKey}`,
		"User-Agent": RESEND_USER_AGENT,
	};
}

export class ResendClient {
	constructor(private readonly fetchImpl: FetchLike = fetch) {}

	/**
	 * A sending-only key cannot list API keys. Resend deliberately returns
	 * `restricted_api_key` for that valid least-privilege credential, while an
	 * invalid credential returns `invalid_api_key`.
	 */
	async validateApiKey(
		apiKey: string,
		signal?: AbortSignal,
	): Promise<ResendCredentialPermission> {
		const response = await this.fetchImpl(`${RESEND_API}/api-keys`, {
			method: "GET",
			headers: headers(apiKey),
			signal: requestSignal(signal),
		});
		if (response.ok) return "full_access";
		const error = await providerError(response);
		if (error.status === 401 && error.code === "restricted_api_key") {
			return "sending_access";
		}
		throw error;
	}

	async sendEmail(
		apiKey: string,
		input: {
			from: string;
			to: string[];
			subject: string;
			text: string;
			idempotencyKey: string;
		},
		signal?: AbortSignal,
	): Promise<{ id: string }> {
		const response = await this.fetchImpl(`${RESEND_API}/emails`, {
			method: "POST",
			headers: {
				...headers(apiKey),
				"Content-Type": "application/json",
				"Idempotency-Key": input.idempotencyKey,
			},
			body: JSON.stringify({
				from: input.from,
				to: input.to,
				subject: input.subject,
				text: input.text,
			}),
			signal: requestSignal(signal),
		});
		if (!response.ok) throw await providerError(response);
		const body = (await response.json()) as { id?: unknown };
		if (typeof body.id !== "string" || body.id.length === 0) {
			throw new ResendApiError(
				"resend_response_invalid",
				502,
				"Resend response did not include an email id",
			);
		}
		return { id: body.id };
	}
}
