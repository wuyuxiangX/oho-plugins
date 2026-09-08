import { hashCanonicalJson, type ToolManifest } from "./contracts.js";
import { ConnectorProviderError } from "./oauth.js";
import { ConnectorServiceError } from "./errors.js";
import type { ToolImplementationContext } from "./tool.js";
import { ToolImplementationError } from "./tool.js";

export function connectorManifest(
	content: Omit<ToolManifest, "schemaHash">,
): ToolManifest {
	return Object.freeze({
		...content,
		schemaHash: hashCanonicalJson({
			inputSchema: content.inputSchema,
			outputSchema: content.outputSchema,
		}),
	});
}

export function requireConnectorConnection(
	context: ToolImplementationContext,
	operationId: string,
): string {
	if (
		!context.agentConnectionId ||
		context.operationId !== operationId ||
		!context.policyHash
	) {
		throw new Error(`${operationId}_agent_connection_capability_missing`);
	}
	return context.agentConnectionId;
}

export async function executeConnectorRead<T>(
	providerName: string,
	operation: () => Promise<T>,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (
			error instanceof ConnectorServiceError &&
			(error.code.endsWith("_connection_unavailable") ||
				error.code.endsWith("_reauthorization_required"))
		) {
			throw new ToolImplementationError(
				"auth_required",
				`${providerName} connection requires authorization`,
				false,
			);
		}
		if (error instanceof ConnectorProviderError) {
			if (error.status === 401) {
				throw new ToolImplementationError(
					"auth_required",
					`${providerName} authorization is no longer valid`,
					false,
				);
			}
			if (error.status === 403) {
				const category = error.code.toLowerCase().includes("scope")
					? "missing_scope"
					: "resource_forbidden";
				throw new ToolImplementationError(
					"provider_error",
					`${providerName} denied access to this operation or resource`,
					false,
					{ category, providerCode: error.code },
				);
			}
			if (error.status === 429) {
				throw new ToolImplementationError(
					"rate_limited",
					`${providerName} request was rate limited`,
					true,
					error.retryAfterMs === undefined
						? undefined
						: { retryAfterMs: error.retryAfterMs },
				);
			}
			if (error.status === 408 || error.status >= 500) {
				throw new ToolImplementationError(
					"provider_error",
					`${providerName} is temporarily unavailable`,
					true,
				);
			}
			throw new ToolImplementationError(
				"provider_error",
				`${providerName} request failed`,
				false,
			);
		}
		if (error instanceof DOMException && error.name === "TimeoutError") {
			throw new ToolImplementationError(
				"timeout",
				`${providerName} request timed out`,
				true,
			);
		}
		if (error instanceof TypeError) {
			throw new ToolImplementationError(
				"provider_error",
				`${providerName} network request failed`,
				true,
			);
		}
		throw error;
	}
}

export function privateConnectorAudit(
	kind: string,
	value: Record<string, unknown>,
) {
	return { kind, privatePayloadRedacted: true, ...value };
}
