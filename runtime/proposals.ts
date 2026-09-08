export type ProposalContext = {
	userId: string;
	runId: string;
	toolCallId: string;
	connectionId: string;
	policyHash: string;
};
export type PendingProposal = { id: string; summary: string };

/** Hosts must persist exact payloads and obtain user approval before sending. */
export interface ProposalService {
	createGmailSendProposal(
		input: ProposalContext & { draftId: string },
	): Promise<PendingProposal>;
	createResendSendProposal(
		input: ProposalContext & { to: string[]; subject: string; body: string },
	): Promise<PendingProposal>;
	createSlackMessageProposal(
		input: ProposalContext & { channelId: string; text: string },
	): Promise<PendingProposal>;
}
