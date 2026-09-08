import { describe, expect, it } from "vitest";
import {
	GmailApiError,
	GmailClient,
	isGmailReauthorizationError,
	toMessageSnapshot,
} from "./client.js";

describe("Gmail message normalization", () => {
	it("extracts plain text and bounds persisted model input", () => {
		const body = "x".repeat(70 * 1024);
		const snapshot = toMessageSnapshot({
			id: "message-1",
			threadId: "thread-1",
			payload: {
				mimeType: "multipart/alternative",
				headers: [
					{ name: "From", value: "sender@example.com" },
					{ name: "To", value: "one@example.com, two@example.com" },
					{ name: "Subject", value: "Subject" },
					{ name: "Message-ID", value: "<message-1@example.com>" },
				],
				parts: [
					{
						mimeType: "text/plain",
						body: { data: Buffer.from(body).toString("base64url") },
					},
				],
			},
		});
		expect(snapshot.to).toEqual(["one@example.com", "two@example.com"]);
		expect(snapshot.bodyTruncated).toBe(true);
		expect(Buffer.byteLength(snapshot.body)).toBeLessThanOrEqual(64 * 1024);
	});

	it("preserves OAuth error codes and Retry-After without treating quota errors as reauthorization", async () => {
		const client = new GmailClient(
			async () =>
				new Response(
					JSON.stringify({
						error: "invalid_grant",
						error_description: "expired",
					}),
					{
						status: 400,
						headers: {
							"Content-Type": "application/json",
							"Retry-After": "2",
						},
					},
				),
		);
		const error = await client
			.refreshToken({
				clientId: "id",
				clientSecret: "secret",
				refreshToken: "old",
			})
			.catch((value: unknown) => value);
		expect(error).toBeInstanceOf(GmailApiError);
		expect(error).toMatchObject({
			code: "invalid_grant",
			status: 400,
			retryAfterMs: 2_000,
		});
		expect(isGmailReauthorizationError(error)).toBe(true);
		expect(
			isGmailReauthorizationError(
				new GmailApiError("rateLimitExceeded", 403, "quota"),
			),
		).toBe(false);
	});

	it("preserves Gmail quota reason codes returned with HTTP 403", async () => {
		const client = new GmailClient(async () =>
			Response.json(
				{
					error: {
						status: "PERMISSION_DENIED",
						message: "quota",
						errors: [{ reason: "userRateLimitExceeded" }],
					},
				},
				{ status: 403 },
			),
		);
		const error = await client
			.getProfile("token")
			.catch((value: unknown) => value);
		expect(error).toMatchObject({
			code: "userRateLimitExceeded",
			status: 403,
		});
		expect(isGmailReauthorizationError(error)).toBe(false);
	});

	it("bounds Gmail search fan-out and preserves listed order", async () => {
		let active = 0;
		let maxActive = 0;
		const ids = Array.from({ length: 9 }, (_, index) => `thread-${index}`);
		const client = new GmailClient(async (input) => {
			const url = String(input);
			if (url.includes("/users/me/threads?")) {
				return Response.json({ threads: ids.map((id) => ({ id })) });
			}
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active -= 1;
			const id = ids.find((candidate) => url.includes(candidate));
			return Response.json({
				messages: id ? [{ id: `message-${id}`, threadId: id }] : [],
			});
		});
		const result = await client.searchThreads("token", "newer:1d", ids.length);
		expect(maxActive).toBeLessThanOrEqual(4);
		expect(result.map((thread) => thread.id)).toEqual(ids);
	});

	it("lists the documented label shape with a bounded result and no fabricated counters", async () => {
		const client = new GmailClient(async (input) => {
			const url = String(input);
			if (url.endsWith("/users/me/labels")) {
				return Response.json({
					labels: Array.from({ length: 101 }, (_, index) => ({
						id: index === 0 ? "INBOX" : `Label_${index}`,
						name: index === 0 ? "INBOX" : `Label ${index}`,
						type: index === 0 ? "system" : "user",
					})),
				});
			}
			if (url.includes("/users/me/drafts?")) {
				return Response.json({ drafts: [{ id: "draft-1" }] });
			}
			return Response.json({
				id: "draft-1",
				message: {
					id: "message-1",
					threadId: "thread-1",
					payload: {
						headers: [
							{ name: "To", value: "reader@example.com" },
							{ name: "Subject", value: "Draft subject" },
							{ name: "Date", value: "Thu, 13 Aug 2026 00:00:00 +0000" },
						],
					},
				},
			});
		});
		const labels = await client.listLabels("token");
		expect(labels.truncated).toBe(true);
		expect(labels.labels).toHaveLength(100);
		expect(labels.labels[0]).toEqual(
			expect.objectContaining({ id: "INBOX", type: "system" }),
		);
		expect(labels.labels[0]).not.toHaveProperty("messagesUnread");
		await expect(client.listDrafts("token", 10)).resolves.toEqual([
			expect.objectContaining({
				draftId: "draft-1",
				messageId: "message-1",
				subject: "Draft subject",
			}),
		]);
	});

	it("sends the exact approved payload instead of a mutable Gmail draft", async () => {
		let requestUrl = "";
		let requestBody = "";
		const client = new GmailClient(async (input, init) => {
			requestUrl = String(input);
			requestBody = String(init?.body ?? "");
			return Response.json({ id: "sent-1", threadId: "thread-1" });
		});
		const result = await client.sendMessage("token", {
			to: ["reader@example.com"],
			subject: "Approved subject",
			body: "Approved body",
			messageId: "<approved@oho.local>",
		});
		const raw = JSON.parse(requestBody).raw as string;
		const decoded = Buffer.from(raw, "base64url").toString("utf8");

		expect(requestUrl).toContain("/users/me/messages/send");
		expect(result).toEqual({ id: "sent-1", threadId: "thread-1" });
		expect(decoded).toContain("To: reader@example.com");
		expect(decoded).toContain("Message-ID: <approved@oho.local>");
		expect(decoded).toContain("Approved body");
	});

	it("accepts Gmail's empty success response when cleaning up a sent draft", async () => {
		const client = new GmailClient(
			async () => new Response(null, { status: 204 }),
		);
		await expect(
			client.deleteDraft("token", "draft-1"),
		).resolves.toBeUndefined();
	});
});
