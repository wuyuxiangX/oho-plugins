import { describe, expect, it, vi } from "vitest";
import { ResendApiError, ResendClient } from "./client.js";

const TEST_KEY = "re_test_only_not_a_real_key";

describe("ResendClient", () => {
	it("accepts a valid sending_access key without requesting broader access", async () => {
		const fetchImpl = vi.fn(
			async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						name: "restricted_api_key",
						message: "This API key is restricted to only send emails.",
					}),
					{ status: 401, headers: { "Content-Type": "application/json" } },
				),
		);
		const client = new ResendClient(fetchImpl as typeof fetch);

		await expect(client.validateApiKey(TEST_KEY)).resolves.toBe(
			"sending_access",
		);
		expect(fetchImpl).toHaveBeenCalledOnce();
		const [, init] = fetchImpl.mock.calls[0] ?? [];
		expect(init?.headers).toMatchObject({
			Authorization: `Bearer ${TEST_KEY}`,
			"User-Agent": "Oho/0.0.0",
		});
	});

	it("rejects invalid credentials instead of storing an unverified key", async () => {
		const client = new ResendClient(
			vi.fn(
				async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
					new Response(
						JSON.stringify({
							name: "invalid_api_key",
							message: "API key is invalid.",
						}),
						{ status: 403, headers: { "Content-Type": "application/json" } },
					),
			) as typeof fetch,
		);

		await expect(client.validateApiKey(TEST_KEY)).rejects.toMatchObject({
			name: "ResendApiError",
			code: "invalid_api_key",
			status: 403,
		});
	});

	it("sends plain text with a stable idempotency key and required User-Agent", async () => {
		const fetchImpl = vi.fn(
			async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
				new Response(JSON.stringify({ id: "email-provider-1" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const client = new ResendClient(fetchImpl as typeof fetch);

		await expect(
			client.sendEmail(TEST_KEY, {
				from: "agent@example.com",
				to: ["person@example.net"],
				subject: "Status",
				text: "Ready",
				idempotencyKey: "proposal:one:revision:one",
			}),
		).resolves.toEqual({ id: "email-provider-1" });

		const [url, init] = fetchImpl.mock.calls[0] ?? [];
		expect(url).toBe("https://api.resend.com/emails");
		expect(init?.headers).toMatchObject({
			Authorization: `Bearer ${TEST_KEY}`,
			"Idempotency-Key": "proposal:one:revision:one",
			"User-Agent": "Oho/0.0.0",
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			from: "agent@example.com",
			to: ["person@example.net"],
			subject: "Status",
			text: "Ready",
		});
	});

	it("preserves retry guidance without performing hidden retries", async () => {
		const fetchImpl = vi.fn(
			async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						name: "rate_limit_exceeded",
						message: "Too many requests.",
					}),
					{
						status: 429,
						headers: {
							"Content-Type": "application/json",
							"Retry-After": "2",
						},
					},
				),
		);
		const client = new ResendClient(fetchImpl as typeof fetch);

		await expect(
			client.sendEmail(TEST_KEY, {
				from: "agent@example.com",
				to: ["person@example.net"],
				subject: "Status",
				text: "Ready",
				idempotencyKey: "proposal:one:revision:one",
			}),
		).rejects.toEqual(
			expect.objectContaining<Partial<ResendApiError>>({
				code: "rate_limit_exceeded",
				status: 429,
				retryAfterMs: 2_000,
			}),
		);
		expect(fetchImpl).toHaveBeenCalledOnce();
	});
});
