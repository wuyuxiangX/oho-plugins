import { describe, expect, it } from "vitest";
import { ConnectorProviderError } from "./oauth.js";
import { executeConnectorRead } from "./read-support.js";
import { ToolImplementationError } from "./tool.js";

describe("connector read error classification", () => {
	it("reserves auth_required for invalid credentials", async () => {
		const error = await executeConnectorRead("Provider", async () => {
			throw new ConnectorProviderError(
				"provider",
				"invalid_token",
				401,
				"invalid",
			);
		}).catch((value: unknown) => value);

		expect(error).toBeInstanceOf(ToolImplementationError);
		expect(error).toMatchObject({ code: "auth_required", retryable: false });
	});

	it("keeps missing-scope and resource-level 403 failures distinct from authentication", async () => {
		for (const expected of [
			{ providerCode: "missing_scope", category: "missing_scope" },
			{
				providerCode: "forbiddenForNonOrganizer",
				category: "resource_forbidden",
			},
		]) {
			const error = await executeConnectorRead("Provider", async () => {
				throw new ConnectorProviderError(
					"provider",
					expected.providerCode,
					403,
					"forbidden",
				);
			}).catch((value: unknown) => value);

			expect(error).toBeInstanceOf(ToolImplementationError);
			expect(error).toMatchObject({
				code: "provider_error",
				retryable: false,
				details: expected,
			});
		}
	});
});
