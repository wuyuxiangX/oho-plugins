import {
	hashCanonicalJson,
	type ToolManifest,
} from "../../../../runtime/contracts.js";
import { z } from "zod";
import type { ProposalService } from "../../../../runtime/proposals.js";
import { ProposalServiceError } from "../../../../runtime/errors.js";
import type {
	RegisteredTool,
	ToolImplementationContext,
} from "../../../../runtime/tool.js";
import { ToolImplementationError } from "../../../../runtime/tool.js";

const emailSchema = z
	.string()
	.email()
	.max(320)
	.refine((value) => !/[\r\n]/.test(value), "email contains a line break");

const sendInput = z
	.object({
		to: z.array(emailSchema).min(1).max(10),
		subject: z
			.string()
			.max(998)
			.refine(
				(value) => !/[\r\n]/.test(value),
				"subject contains a line break",
			),
		body: z.string().max(64 * 1024),
	})
	.strict();

const sendOutput = z
	.object({
		proposalId: z.string(),
		status: z.literal("pending"),
		summary: z.string(),
	})
	.strict();

type SendInput = z.infer<typeof sendInput>;
type SendOutput = z.infer<typeof sendOutput>;

function manifest(content: Omit<ToolManifest, "schemaHash">): ToolManifest {
	return Object.freeze({
		...content,
		schemaHash: hashCanonicalJson({
			inputSchema: content.inputSchema,
			outputSchema: content.outputSchema,
		}),
	});
}

export const RESEND_SEND_MANIFEST = manifest({
	id: "resend.email.send",
	runtimeName: "resend_propose_send",
	version: "1.0.0",
	label: "申请通过 Resend 发送邮件",
	description:
		"Create an exact, durable proposal for a plain-text transactional email. Resend sends only after the user approves that revision.",
	inputSchema: {
		type: "object",
		properties: {
			to: {
				type: "array",
				items: { type: "string", format: "email" },
				minItems: 1,
				maxItems: 10,
			},
			subject: { type: "string", maxLength: 998 },
			body: { type: "string", maxLength: 65_536 },
		},
		required: ["to", "subject", "body"],
		additionalProperties: false,
	},
	outputSchema: { type: "object" },
	risk: "high",
	sideEffect: "irreversible",
	network: "restricted",
	timeoutMs: 20_000,
	maxCallsPerRun: 2,
	executionMode: "sequential",
});

export const RESEND_TOOL_REFS = {
	"resend.email.send": `${RESEND_SEND_MANIFEST.id}@${RESEND_SEND_MANIFEST.version}`,
} as const;

function requireConnection(context: ToolImplementationContext): string {
	if (
		!context.agentConnectionId ||
		context.operationId !== "resend.email.send" ||
		!context.policyHash
	) {
		throw new Error("resend_agent_connection_capability_missing");
	}
	return context.agentConnectionId;
}

export function createResendTools(
	proposals: ProposalService,
): RegisteredTool[] {
	const sendTool: RegisteredTool<SendInput, SendOutput> = {
		manifest: RESEND_SEND_MANIFEST,
		inputValidator: sendInput,
		outputValidator: sendOutput,
		async execute(input, context) {
			const connectionId = requireConnection(context);
			try {
				const proposal = await proposals.createResendSendProposal({
					userId: context.userId,
					runId: context.runId,
					toolCallId: context.toolCallId,
					connectionId,
					policyHash: context.policyHash!,
					to: input.to,
					subject: input.subject,
					body: input.body,
				});
				return {
					proposalId: proposal.id,
					status: "pending" as const,
					summary: proposal.summary,
				};
			} catch (error) {
				if (error instanceof ProposalServiceError) {
					throw new ToolImplementationError(
						"tool_execution_failed",
						error.message,
						false,
					);
				}
				throw error;
			}
		},
		toPersistedOutput: (output) => ({
			kind: "resend.email.send",
			privatePayloadRedacted: true,
			proposalId: output.proposalId,
			status: output.status,
		}),
	};
	return [sendTool];
}
