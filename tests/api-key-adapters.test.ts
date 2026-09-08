import { describe, expect, it, vi } from "vitest";
import { LinearClient } from "../plugins/oho/linear/src/client.js";
import { ConnectorProviderError } from "../runtime/oauth.js";
import { StripeClient } from "../plugins/oho/stripe/src/client.js";

describe("API-key connector adapters", () => {
	it("validates Linear identity and returns bounded issues", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					data: {
						viewer: {
							id: "user-1",
							email: "owner@example.com",
							organization: { id: "org-1", name: "Oho" },
						},
					},
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					data: {
						issues: {
							nodes: [
								{
									id: "issue-1",
									identifier: "OHO-1",
									title: "Connector foundation",
									url: "https://linear.app/oho/issue/OHO-1",
									priority: 2,
									state: { name: "In Progress" },
									team: { name: "Product" },
									updatedAt: "2026-08-13T00:00:00Z",
								},
							],
						},
					},
				}),
			);
		const client = new LinearClient(fetchImpl);
		await expect(client.validateApiKey("lin_api_test")).resolves.toEqual({
			id: "org-1",
			label: "Oho",
		});
		await expect(client.listIssues("lin_api_test", 25)).resolves.toEqual([
			expect.objectContaining({ id: "issue-1", identifier: "OHO-1" }),
		]);
		const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<
			string,
			string
		>;
		expect(headers.Authorization).toBe("lin_api_test");
		expect(String(fetchImpl.mock.calls[1]?.[1]?.body)).not.toContain(
			"lin_api_test",
		);
	});

	it("requires a Stripe restricted key and keeps money as decimal strings", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ object: "list", data: [] }))
			.mockResolvedValueOnce(
				Response.json({
					object: "list",
					data: [
						{
							id: "pi_1",
							amount: 1099,
							amount_received: 1099,
							currency: "usd",
							status: "succeeded",
							created: 1_786_579_200,
							description: "Order 1",
							livemode: false,
						},
					],
				}),
			);
		const client = new StripeClient(fetchImpl);
		await expect(
			client.validateRestrictedKey("sk_test_broad_key"),
		).rejects.toMatchObject({
			code: "restricted_key_required",
			status: 403,
		});
		await expect(
			client.validateRestrictedKey("rk_test_restricted"),
		).resolves.toMatchObject({ id: "test" });
		await expect(
			client.listPaymentIntents("rk_test_restricted", 20),
		).resolves.toEqual([
			expect.objectContaining({
				id: "pi_1",
				amount: "1099",
				amountReceived: "1099",
			}),
		]);
	});

	it("supports Linear issue detail, search, workspace structure, and comments as bounded reads", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
			const request = JSON.parse(String(init?.body ?? "{}")) as {
				query?: string;
			};
			if (request.query?.includes("OhoConnectorIssueSearch")) {
				return Response.json({
					data: {
						issueSearch: {
							nodes: [
								{ id: "issue-1", identifier: "OHO-1", title: "Connector" },
							],
						},
					},
				});
			}
			if (request.query?.includes("OhoConnectorTeams")) {
				return Response.json({
					data: {
						teams: { nodes: [{ id: "team-1", key: "OHO", name: "Product" }] },
					},
				});
			}
			if (request.query?.includes("OhoConnectorProjects")) {
				return Response.json({
					data: {
						projects: {
							nodes: [{ id: "project-1", name: "Launch", progress: 0.5 }],
						},
					},
				});
			}
			if (request.query?.includes("OhoConnectorIssueComments")) {
				return Response.json({
					data: {
						issue: {
							comments: {
								nodes: [
									{ id: "comment-1", body: "Ready", user: { name: "Alice" } },
								],
							},
						},
					},
				});
			}
			return Response.json({
				data: {
					issue: {
						id: "issue-1",
						identifier: "OHO-1",
						title: "Connector",
						description: "Read integration",
						labels: { nodes: [{ name: "platform" }] },
					},
				},
			});
		});
		const client = new LinearClient(fetchImpl);
		await expect(client.readIssue("key", "OHO-1")).resolves.toMatchObject({
			id: "issue-1",
			labels: ["platform"],
		});
		await expect(client.searchIssues("key", "Connector", 25)).resolves.toEqual([
			expect.objectContaining({ id: "issue-1" }),
		]);
		await expect(client.listTeams("key", 25)).resolves.toEqual([
			expect.objectContaining({ id: "team-1" }),
		]);
		await expect(client.listProjects("key", 25)).resolves.toEqual([
			expect.objectContaining({ id: "project-1", progress: 0.5 }),
		]);
		await expect(client.listIssueComments("key", "OHO-1", 25)).resolves.toEqual(
			[expect.objectContaining({ id: "comment-1", author: "Alice" })],
		);
	});

	it("retrieves and searches Stripe Payment Intents without exposing secret fields", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async (input) => {
			const url = String(input);
			const intent = {
				id: "pi_1",
				amount: 1099,
				amount_received: 0,
				currency: "usd",
				status: "requires_payment_method",
				client_secret: "must-not-leak",
				livemode: false,
			};
			return url.includes("/search?")
				? Response.json({ data: [intent], next_page: "next" })
				: Response.json(intent);
		});
		const client = new StripeClient(fetchImpl);
		const detail = await client.readPaymentIntent("rk_test_restricted", "pi_1");
		expect(detail).toMatchObject({ id: "pi_1", amount: "1099" });
		expect(JSON.stringify(detail)).not.toContain("must-not-leak");
		await expect(
			client.searchPaymentIntents("rk_test_restricted", {
				query: "status:'requires_payment_method'",
				limit: 20,
			}),
		).resolves.toMatchObject({
			paymentIntents: [{ id: "pi_1" }],
			nextPage: "next",
		});
		expect(String(fetchImpl.mock.calls[1]?.[0])).toContain(
			"query=status%3A%27requires_payment_method%27",
		);
	});
});
