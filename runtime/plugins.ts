import { createTools as github } from "../plugins/oho/github/src/index.js";
import { createTools as gmail } from "../plugins/oho/gmail/src/index.js";
import { createTools as slack } from "../plugins/oho/slack/src/index.js";
import { createTools as notion } from "../plugins/oho/notion/src/index.js";
import { createTools as feishu } from "../plugins/oho/feishu/src/index.js";
import { createTools as lark } from "../plugins/oho/lark/src/index.js";
import { createTools as googleCalendar } from "../plugins/oho/google-calendar/src/index.js";
import { createTools as googleDrive } from "../plugins/oho/google-drive/src/index.js";
import { createTools as googleSheets } from "../plugins/oho/google-sheets/src/index.js";
import { createTools as linear } from "../plugins/oho/linear/src/index.js";
import { createTools as stripe } from "../plugins/oho/stripe/src/index.js";
import { createTools as resend } from "../plugins/oho/resend/src/index.js";
import { ProposalServiceError } from "./errors.js";
import type { ProposalService } from "./proposals.js";
import type { ProviderService } from "./service.js";
import type { RegisteredTool } from "./tool.js";

// This bridge exposes reads. Sending still requires a host with durable approval
// and resume support; it must never silently fall back to a direct provider call.
export const unavailableProposals: ProposalService = {
	createGmailSendProposal: async () => {
		throw new ProposalServiceError("approval_host_required");
	},
	createResendSendProposal: async () => {
		throw new ProposalServiceError("approval_host_required");
	},
	createSlackMessageProposal: async () => {
		throw new ProposalServiceError("approval_host_required");
	},
};

export const pluginIds = [
	"github",
	"gmail",
	"slack",
	"notion",
	"feishu",
	"lark",
	"google-calendar",
	"google-drive",
	"google-sheets",
	"linear",
	"stripe",
	"resend",
] as const;
export type PluginId = (typeof pluginIds)[number];

export function createPluginTools(
	id: PluginId,
	service: ProviderService,
	proposals = unavailableProposals,
): RegisteredTool[] {
	switch (id) {
		case "github":
			return github(service);
		case "gmail":
			return gmail(service, proposals);
		case "slack":
			return slack(service, proposals);
		case "notion":
			return notion(service);
		case "feishu":
			return feishu(service);
		case "lark":
			return lark(service);
		case "google-calendar":
			return googleCalendar(service);
		case "google-drive":
			return googleDrive(service);
		case "google-sheets":
			return googleSheets(service);
		case "linear":
			return linear(service);
		case "stripe":
			return stripe(service);
		case "resend":
			return resend(proposals);
	}
}
