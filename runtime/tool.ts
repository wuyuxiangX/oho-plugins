import type { ToolManifest } from "./contracts.js";
type RunToolDisplayCategory = string;
type RunToolPublicField = {
	label: string;
	value: unknown;
	[key: string]: unknown;
};
import type { z } from "zod";

export type ToolImplementationContext = {
	runId: string;
	userId: string;
	toolCallId: string;
	defaultTimeZone: string;
	agentConnectionId?: string;
	operationId?: string;
	policyHash?: string;
	signal?: AbortSignal;
};

export type ToolPublicTraceValue = {
	data: unknown;
	fields: RunToolPublicField[];
};

export type ToolPublicPresentation = {
	title: string;
	category: RunToolDisplayCategory;
	/** Connector/brand identity for brand icons (e.g. "google_calendar"). */
	brand?: string;
};

export type ToolPublicTraceProjection = {
	/**
	 * Fail-closed, user-visible projection. It may receive a legacy value that
	 * was already projected, so implementations must be idempotent.
	 */
	arguments?(value: unknown): ToolPublicTraceValue;
	result?(value: unknown): ToolPublicTraceValue;
};

export type RegisteredTool<TInput = unknown, TOutput = unknown> = {
	manifest: ToolManifest;
	/** Declarative user-facing action metadata; generic clients render it. */
	publicPresentation?: ToolPublicPresentation;
	inputValidator: z.ZodType<TInput>;
	outputValidator: z.ZodType<TOutput>;
	/** Optional safe projection used by public Run traces. Omitted fields redact. */
	publicTrace?: ToolPublicTraceProjection;
	/** Content exposed to the model for this Run. It is never used as audit data. */
	toModelContent?(output: TOutput): string;
	/** Durable audit projection. Sensitive provider payloads must be removed here. */
	toPersistedOutput?(output: TOutput): unknown;
	execute(
		input: TInput,
		context: ToolImplementationContext,
	): Promise<TOutput> | TOutput;
};

export class ToolImplementationError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryable: boolean,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "ToolImplementationError";
	}
}
