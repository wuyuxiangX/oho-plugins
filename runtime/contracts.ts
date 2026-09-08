import { createHash } from "node:crypto";
/** Provider-neutral Tool contracts owned by Oho. */

export type JsonSchema = Record<string, unknown>;

export type ToolRisk = "low" | "medium" | "high";
export type ToolSideEffect = "none" | "reversible" | "irreversible";
export type ToolNetworkAccess = "none" | "restricted" | "unrestricted";
export type ToolExecutionMode = "sequential" | "parallel";

export type ToolManifest = {
	/** Stable Oho business identifier, e.g. system.time.now. */
	id: string;
	/** Provider-safe identifier, e.g. system_time_now. */
	runtimeName: string;
	version: string;
	label: string;
	description: string;
	inputSchema: JsonSchema;
	outputSchema: JsonSchema;
	schemaHash: string;
	risk: ToolRisk;
	sideEffect: ToolSideEffect;
	network: ToolNetworkAccess;
	timeoutMs: number;
	maxCallsPerRun: number;
	executionMode: ToolExecutionMode;
};

export function hashCanonicalJson(value: unknown): string {
	const canonical = (item: unknown): unknown =>
		Array.isArray(item)
			? item.map(canonical)
			: item && typeof item === "object"
				? Object.fromEntries(
						Object.entries(item)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([key, val]) => [key, canonical(val)]),
					)
				: item;
	return createHash("sha256")
		.update(JSON.stringify(canonical(value)))
		.digest("hex");
}
