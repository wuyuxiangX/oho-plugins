import {
	ConnectorProviderError,
	connectorRequestSignal,
	retryAfterMs,
} from "../../../../runtime/oauth.js";

const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_USER_AGENT = "Oho/0.0.0";

type FetchLike = typeof fetch;

export type StripePaymentIntent = {
	id: string;
	amount: string;
	amountReceived: string;
	currency: string;
	status: string;
	createdAt: string;
	description: string;
	livemode: boolean;
};

type StripePaymentIntentResource = {
	id?: string;
	amount?: number;
	amount_received?: number;
	currency?: string;
	status?: string;
	created?: number;
	description?: string | null;
	livemode?: boolean;
};

function mapPaymentIntent(
	intent: StripePaymentIntentResource,
): StripePaymentIntent | null {
	if (!intent.id) return null;
	return {
		id: intent.id,
		amount: String(intent.amount ?? 0),
		amountReceived: String(intent.amount_received ?? 0),
		currency: (intent.currency ?? "").slice(0, 16),
		status: (intent.status ?? "").slice(0, 64),
		createdAt: intent.created
			? new Date(intent.created * 1_000).toISOString()
			: "",
		description: (intent.description ?? "").slice(0, 2_000),
		livemode: intent.livemode === true,
	};
}

async function stripeJson<T>(response: Response): Promise<T> {
	const body = (await response.json().catch(() => ({}))) as {
		error?: { code?: string; message?: string; type?: string };
	};
	if (!response.ok || body.error) {
		throw new ConnectorProviderError(
			"stripe",
			body.error?.code ?? body.error?.type ?? `stripe_http_${response.status}`,
			response.status,
			body.error?.message ?? `Stripe request failed (${response.status})`,
			retryAfterMs(response),
		);
	}
	return body as T;
}

export class StripeClient {
	constructor(private readonly fetchImpl: FetchLike = fetch) {}

	private async request<T>(
		apiKey: string,
		path: string,
		signal?: AbortSignal,
	): Promise<{ body: T; requestId?: string }> {
		const response = await this.fetchImpl(`${STRIPE_API}${path}`, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
				"User-Agent": STRIPE_USER_AGENT,
			},
			signal: connectorRequestSignal(signal),
		});
		return {
			body: await stripeJson<T>(response),
			requestId: response.headers.get("Request-Id") ?? undefined,
		};
	}

	async validateRestrictedKey(apiKey: string, signal?: AbortSignal) {
		if (!/^rk_(test|live)_/.test(apiKey)) {
			throw new ConnectorProviderError(
				"stripe",
				"restricted_key_required",
				403,
				"Stripe requires a restricted API key for this connection",
			);
		}
		await this.request(apiKey, "/payment_intents?limit=1", signal);
		return {
			id: apiKey.startsWith("rk_live_") ? "live" : "test",
			label: apiKey.startsWith("rk_live_")
				? "Stripe 正式模式（限权 Key）"
				: "Stripe 测试模式（限权 Key）",
		};
	}

	async listPaymentIntents(
		apiKey: string,
		limit: number,
		signal?: AbortSignal,
	): Promise<StripePaymentIntent[]> {
		const { body } = await this.request<{
			data?: StripePaymentIntentResource[];
		}>(apiKey, `/payment_intents?limit=${limit}`, signal);
		return (body.data ?? []).flatMap((intent) => {
			const mapped = mapPaymentIntent(intent);
			return mapped ? [mapped] : [];
		});
	}

	async readPaymentIntent(
		apiKey: string,
		paymentIntentId: string,
		signal?: AbortSignal,
	): Promise<StripePaymentIntent> {
		const { body } = await this.request<StripePaymentIntentResource>(
			apiKey,
			`/payment_intents/${encodeURIComponent(paymentIntentId)}`,
			signal,
		);
		const intent = mapPaymentIntent(body);
		if (!intent) {
			throw new ConnectorProviderError(
				"stripe",
				"payment_intent_identity_missing",
				502,
				"Stripe did not return the requested Payment Intent identity",
			);
		}
		return intent;
	}

	async searchPaymentIntents(
		apiKey: string,
		input: { query: string; limit: number; page?: string },
		signal?: AbortSignal,
	): Promise<{ paymentIntents: StripePaymentIntent[]; nextPage?: string }> {
		const params = new URLSearchParams({
			query: input.query,
			limit: String(input.limit),
		});
		if (input.page) params.set("page", input.page);
		const { body } = await this.request<{
			data?: StripePaymentIntentResource[];
			next_page?: string | null;
		}>(apiKey, `/payment_intents/search?${params.toString()}`, signal);
		return {
			paymentIntents: (body.data ?? []).flatMap((intent) => {
				const mapped = mapPaymentIntent(intent);
				return mapped ? [mapped] : [];
			}),
			...(body.next_page ? { nextPage: body.next_page } : {}),
		};
	}
}
