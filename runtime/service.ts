import { ConnectorServiceError } from "./errors.js";
import * as ids from "./provider-metadata.js";
import type { ConnectorId } from "./provider-metadata.js";
import {
	GmailClient,
	type GmailDraftSnapshot,
} from "../plugins/oho/gmail/src/client.js";
import { GitHubClient } from "../plugins/oho/github/src/client.js";
import { SlackClient } from "../plugins/oho/slack/src/client.js";
import { NotionClient } from "../plugins/oho/notion/src/client.js";
import { LinearClient } from "../plugins/oho/linear/src/client.js";
import { StripeClient } from "../plugins/oho/stripe/src/client.js";
import { ResendClient } from "../plugins/oho/resend/src/client.js";
import { LarkClient } from "../providers/lark/client.js";
import { GoogleWorkspaceClient } from "../providers/google-workspace/client.js";
const {
	GMAIL_CONNECTOR_ID,
	GITHUB_CONNECTOR_ID,
	SLACK_CONNECTOR_ID,
	NOTION_CONNECTOR_ID,
	FEISHU_CONNECTOR_ID,
	LARK_CONNECTOR_ID,
	GOOGLE_CALENDAR_CONNECTOR_ID,
	GOOGLE_DRIVE_CONNECTOR_ID,
	GOOGLE_SHEETS_CONNECTOR_ID,
	LINEAR_CONNECTOR_ID,
	STRIPE_CONNECTOR_ID,
} = ids;

export type ProviderCredential = {
	accessToken: string;
	defaultFrom?: string;
	expiresAt?: string;
	version: string;
};
export type CredentialResolver = (input: {
	userId: string;
	connectionId: string;
	connectorId: ConnectorId;
}) => Promise<ProviderCredential>;

/** Provider operations use injected account custody; no Oho database or global credentials. */
export class ProviderService {
	private readonly gmail: GmailClient;
	private readonly resend: ResendClient;
	private readonly linear: LinearClient;
	private readonly stripe: StripeClient;
	private readonly oauthClients;

	constructor(
		private readonly credentials: CredentialResolver,
		fetchImpl: typeof fetch = fetch,
	) {
		this.gmail = new GmailClient(fetchImpl);
		this.resend = new ResendClient(fetchImpl);
		this.linear = new LinearClient(fetchImpl);
		this.stripe = new StripeClient(fetchImpl);
		this.oauthClients = {
			github: new GitHubClient(undefined, undefined, fetchImpl),
			slack: new SlackClient(undefined, fetchImpl),
			notion: new NotionClient(undefined, undefined, fetchImpl),
			feishu: new LarkClient(
				undefined,
				undefined,
				fetchImpl,
				() => new Date(),
				"feishu",
			),
			lark: new LarkClient(undefined, undefined, fetchImpl),
			googleCalendar: new GoogleWorkspaceClient(
				"google_calendar",
				ids.GOOGLE_CALENDAR_SCOPES,
				undefined,
				undefined,
				fetchImpl,
			),
			googleDrive: new GoogleWorkspaceClient(
				"google_drive",
				ids.GOOGLE_DRIVE_SCOPES,
				undefined,
				undefined,
				fetchImpl,
			),
			googleSheets: new GoogleWorkspaceClient(
				"google_sheets",
				ids.GOOGLE_SHEETS_SCOPES,
				undefined,
				undefined,
				fetchImpl,
			),
		};
	}

	async credential(
		userId: string,
		connectionId: string,
		connectorId: ConnectorId,
	): Promise<ProviderCredential> {
		const credential = await this.credentials({
			userId,
			connectionId,
			connectorId,
		});
		if (
			!credential.accessToken ||
			!credential.version ||
			(credential.expiresAt &&
				(!Number.isFinite(Date.parse(credential.expiresAt)) ||
					Date.parse(credential.expiresAt) <= Date.now()))
		) {
			throw new ConnectorServiceError(
				`${connectorId}_reauthorization_required`,
				403,
				"This account requires authorization",
			);
		}
		return credential;
	}

	private async withAccessToken<T>(
		userId: string,
		connectionId: string,
		connectorId: ConnectorId,
		signal: AbortSignal | undefined,
		operation: (token: string) => Promise<T>,
	): Promise<T> {
		signal?.throwIfAborted();
		const credential = await this.credential(userId, connectionId, connectorId);
		signal?.throwIfAborted();
		return operation(credential.accessToken);
	}

	private withApiCredential<T>(
		userId: string,
		connectionId: string,
		connectorId: "linear" | "stripe",
		operation: (key: string) => Promise<T>,
	): Promise<T> {
		return this.withAccessToken(
			userId,
			connectionId,
			connectorId,
			undefined,
			operation,
		);
	}

	async getResendDefaultSender(
		userId: string,
		connectionId: string,
	): Promise<string> {
		const credential = await this.credential(userId, connectionId, "resend");
		if (!credential.defaultFrom)
			throw new ConnectorServiceError(
				"resend_sender_missing",
				400,
				"Configure a sender email address",
			);
		return credential.defaultFrom;
	}

	async sendResendEmail(
		userId: string,
		connectionId: string,
		input: {
			from: string;
			to: string[];
			subject: string;
			body: string;
			idempotencyKey: string;
		},
		signal?: AbortSignal,
	): Promise<{ id: string }> {
		const credential = await this.credential(userId, connectionId, "resend");
		if (credential.defaultFrom !== input.from)
			throw new ConnectorServiceError(
				"resend_sender_changed",
				409,
				"The sender changed after approval",
			);
		return this.resend.sendEmail(
			credential.accessToken,
			{ ...input, text: input.body },
			signal,
		);
	}

	async searchMail(
		userId: string,
		connectionId: string,
		query: string,
		limit: number,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GMAIL_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.gmail.searchThreads(accessToken, query, limit, signal),
		);
	}

	async listGmailLabels(
		userId: string,
		connectionId: string,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GMAIL_CONNECTOR_ID,
			signal,
			(accessToken) => this.gmail.listLabels(accessToken, signal),
		);
	}

	async listGmailDrafts(
		userId: string,
		connectionId: string,
		limit: number,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GMAIL_CONNECTOR_ID,
			signal,
			(accessToken) => this.gmail.listDrafts(accessToken, limit, signal),
		);
	}

	async readThread(
		userId: string,
		connectionId: string,
		threadId: string,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GMAIL_CONNECTOR_ID,
			signal,
			(accessToken) => this.gmail.readThread(accessToken, threadId, signal),
		);
	}

	async upsertDraft(
		userId: string,
		connectionId: string,
		input: { draftId?: string; to: string[]; subject: string; body: string },
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GMAIL_CONNECTOR_ID,
			signal,
			(accessToken) => this.gmail.upsertDraft(accessToken, input, signal),
		);
	}

	async getDraft(
		userId: string,
		connectionId: string,
		draftId: string,
		signal?: AbortSignal,
	): Promise<GmailDraftSnapshot> {
		return this.withAccessToken(
			userId,
			connectionId,
			GMAIL_CONNECTOR_ID,
			signal,
			(accessToken) => this.gmail.getDraft(accessToken, draftId, signal),
		);
	}

	async sendMessage(
		userId: string,
		connectionId: string,
		input: { to: string[]; subject: string; body: string; messageId: string },
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GMAIL_CONNECTOR_ID,
			signal,
			(accessToken) => this.gmail.sendMessage(accessToken, input, signal),
		);
	}

	async deleteDraft(
		userId: string,
		connectionId: string,
		draftId: string,
		signal?: AbortSignal,
	): Promise<void> {
		return this.withAccessToken(
			userId,
			connectionId,
			GMAIL_CONNECTOR_ID,
			signal,
			(accessToken) => this.gmail.deleteDraft(accessToken, draftId, signal),
		);
	}

	async findSentByMessageId(
		userId: string,
		connectionId: string,
		messageId: string,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GMAIL_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.gmail.findSentByMessageId(accessToken, messageId, signal),
		);
	}

	async listGitHubRepositories(
		userId: string,
		connectionId: string,
		input: { limit: number; page: number },
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GITHUB_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.github.listPublicRepositories(
					accessToken,
					input,
					signal,
				),
		);
	}

	async searchGitHubRepositories(
		userId: string,
		connectionId: string,
		input: { query: string; limit: number; page: number },
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GITHUB_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.github.searchPublicRepositories(
					accessToken,
					input,
					signal,
				),
		);
	}

	async readGitHubRepository(
		userId: string,
		connectionId: string,
		owner: string,
		repository: string,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GITHUB_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.github.getPublicRepository(
					accessToken,
					owner,
					repository,
					signal,
				),
		);
	}

	async listGitHubRepositoryContents(
		userId: string,
		connectionId: string,
		input: {
			owner: string;
			repository: string;
			path: string;
			ref?: string;
			limit: number;
		},
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GITHUB_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.github.listPublicRepositoryContents(
					accessToken,
					input,
					signal,
				),
		);
	}

	async readGitHubRepositoryFile(
		userId: string,
		connectionId: string,
		input: { owner: string; repository: string; path: string; ref?: string },
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GITHUB_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.github.readPublicRepositoryFile(
					accessToken,
					input,
					signal,
				),
		);
	}

	async listGitHubIssues(
		userId: string,
		connectionId: string,
		input: {
			owner: string;
			repository: string;
			state: "open" | "closed" | "all";
			limit: number;
			page: number;
		},
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GITHUB_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.github.listIssues(accessToken, input, signal),
		);
	}

	async readGitHubIssue(
		userId: string,
		connectionId: string,
		input: { owner: string; repository: string; number: number },
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GITHUB_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.github.getIssue(accessToken, input, signal),
		);
	}

	async listGitHubIssueComments(
		userId: string,
		connectionId: string,
		input: {
			owner: string;
			repository: string;
			number: number;
			limit: number;
			page: number;
		},
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GITHUB_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.github.listIssueComments(accessToken, input, signal),
		);
	}

	async listGitHubPullRequests(
		userId: string,
		connectionId: string,
		input: {
			owner: string;
			repository: string;
			state: "open" | "closed" | "all";
			limit: number;
			page: number;
		},
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GITHUB_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.github.listPullRequests(accessToken, input, signal),
		);
	}

	async readGitHubPullRequest(
		userId: string,
		connectionId: string,
		input: { owner: string; repository: string; number: number },
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GITHUB_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.github.getPullRequest(accessToken, input, signal),
		);
	}

	async listGitHubPullRequestFiles(
		userId: string,
		connectionId: string,
		input: {
			owner: string;
			repository: string;
			number: number;
			limit: number;
			page: number;
		},
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GITHUB_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.github.listPullRequestFiles(
					accessToken,
					input,
					signal,
				),
		);
	}

	async listGitHubCommits(
		userId: string,
		connectionId: string,
		input: {
			owner: string;
			repository: string;
			ref?: string;
			limit: number;
			page: number;
		},
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GITHUB_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.github.listCommits(accessToken, input, signal),
		);
	}

	async readGitHubCommit(
		userId: string,
		connectionId: string,
		input: { owner: string; repository: string; ref: string },
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GITHUB_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.github.getCommit(accessToken, input, signal),
		);
	}

	async listGitHubBranches(
		userId: string,
		connectionId: string,
		input: { owner: string; repository: string; limit: number; page: number },
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GITHUB_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.github.listBranches(accessToken, input, signal),
		);
	}

	async listGitHubReleases(
		userId: string,
		connectionId: string,
		input: { owner: string; repository: string; limit: number; page: number },
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GITHUB_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.github.listReleases(accessToken, input, signal),
		);
	}

	async listSlackChannels(
		userId: string,
		connectionId: string,
		limit: number,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			SLACK_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.slack.listChannels(accessToken, limit, signal),
		);
	}

	async readSlackMessages(
		userId: string,
		connectionId: string,
		channelId: string,
		limit: number,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			SLACK_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.slack.readChannelMessages(
					accessToken,
					channelId,
					limit,
					signal,
				),
		);
	}

	async readSlackChannel(
		userId: string,
		connectionId: string,
		channelId: string,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			SLACK_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.slack.getChannel(accessToken, channelId, signal),
		);
	}

	async readSlackThreadReplies(
		userId: string,
		connectionId: string,
		input: {
			channelId: string;
			threadTimestamp: string;
			limit: number;
			cursor?: string;
		},
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			SLACK_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.slack.readThreadReplies(accessToken, input, signal),
		);
	}

	async sendSlackMessage(
		userId: string,
		connectionId: string,
		input: { channelId: string; text: string; clientMessageId: string },
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			SLACK_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.slack.postMessage(accessToken, input, signal),
		);
	}

	async searchNotionPages(
		userId: string,
		connectionId: string,
		query: string,
		limit: number,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			NOTION_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.notion.searchPages(accessToken, query, limit, signal),
		);
	}

	async readNotionPage(
		userId: string,
		connectionId: string,
		pageId: string,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			NOTION_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.notion.readPage(accessToken, pageId, signal),
		);
	}

	async readNotionPageMetadata(
		userId: string,
		connectionId: string,
		pageId: string,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			NOTION_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.notion.readPageMetadata(accessToken, pageId, signal),
		);
	}

	async listNotionBlockChildren(
		userId: string,
		connectionId: string,
		input: { blockId: string; limit: number; cursor?: string },
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			NOTION_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.notion.listBlockChildren(accessToken, input, signal),
		);
	}

	async listLarkTasks(
		userId: string,
		connectionId: string,
		limit: number,
		pageToken: string | undefined,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			LARK_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.lark.listTasks(accessToken, limit, pageToken, signal),
		);
	}

	async readLarkTask(
		userId: string,
		connectionId: string,
		taskId: string,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			LARK_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.lark.getTask(accessToken, taskId, signal),
		);
	}

	async listFeishuTasks(
		userId: string,
		connectionId: string,
		limit: number,
		pageToken: string | undefined,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			FEISHU_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.feishu.listTasks(
					accessToken,
					limit,
					pageToken,
					signal,
				),
		);
	}

	async readFeishuTask(
		userId: string,
		connectionId: string,
		taskId: string,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			FEISHU_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.feishu.getTask(accessToken, taskId, signal),
		);
	}

	async listGoogleCalendarEvents(
		userId: string,
		connectionId: string,
		input: { timeMin: string; timeMax: string; limit: number },
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GOOGLE_CALENDAR_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.googleCalendar.listCalendarEvents(
					accessToken,
					input,
					signal,
				),
		);
	}

	async listGoogleCalendars(
		userId: string,
		connectionId: string,
		limit: number,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GOOGLE_CALENDAR_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.googleCalendar.listCalendars(
					accessToken,
					limit,
					signal,
				),
		);
	}

	async readGoogleCalendarEvent(
		userId: string,
		connectionId: string,
		calendarId: string,
		eventId: string,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GOOGLE_CALENDAR_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.googleCalendar.readCalendarEvent(
					accessToken,
					calendarId,
					eventId,
					signal,
				),
		);
	}

	async readGoogleCalendarFreeBusy(
		userId: string,
		connectionId: string,
		input: {
			timeMin: string;
			timeMax: string;
			calendarIds: string[];
			timeZone?: string;
		},
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GOOGLE_CALENDAR_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.googleCalendar.readCalendarFreeBusy(
					accessToken,
					input,
					signal,
				),
		);
	}

	async searchGoogleDriveFiles(
		userId: string,
		connectionId: string,
		query: string,
		limit: number,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GOOGLE_DRIVE_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.googleDrive.searchDriveFiles(
					accessToken,
					query,
					limit,
					signal,
				),
		);
	}

	async readGoogleDriveFile(
		userId: string,
		connectionId: string,
		fileId: string,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GOOGLE_DRIVE_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.googleDrive.readDriveFile(
					accessToken,
					fileId,
					signal,
				),
		);
	}

	async listGoogleDriveFolderChildren(
		userId: string,
		connectionId: string,
		input: { folderId: string; limit: number; pageToken?: string },
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GOOGLE_DRIVE_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.googleDrive.listDriveFolderChildren(
					accessToken,
					input,
					signal,
				),
		);
	}

	async readGoogleSheetValues(
		userId: string,
		connectionId: string,
		spreadsheetId: string,
		range: string,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GOOGLE_SHEETS_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.googleSheets.readSheetValues(
					accessToken,
					spreadsheetId,
					range,
					signal,
				),
		);
	}

	async readGoogleSpreadsheetMetadata(
		userId: string,
		connectionId: string,
		spreadsheetId: string,
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GOOGLE_SHEETS_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.googleSheets.readSpreadsheetMetadata(
					accessToken,
					spreadsheetId,
					signal,
				),
		);
	}

	async readGoogleSheetValueRanges(
		userId: string,
		connectionId: string,
		spreadsheetId: string,
		ranges: string[],
		signal?: AbortSignal,
	) {
		return this.withAccessToken(
			userId,
			connectionId,
			GOOGLE_SHEETS_CONNECTOR_ID,
			signal,
			(accessToken) =>
				this.oauthClients.googleSheets.readSheetValueRanges(
					accessToken,
					spreadsheetId,
					ranges,
					signal,
				),
		);
	}

	async listLinearIssues(
		userId: string,
		connectionId: string,
		limit: number,
		signal?: AbortSignal,
	) {
		return this.withApiCredential(
			userId,
			connectionId,
			LINEAR_CONNECTOR_ID,
			(apiKey) => this.linear.listIssues(apiKey, limit, signal),
		);
	}

	async readLinearIssue(
		userId: string,
		connectionId: string,
		issueId: string,
		signal?: AbortSignal,
	) {
		return this.withApiCredential(
			userId,
			connectionId,
			LINEAR_CONNECTOR_ID,
			(apiKey) => this.linear.readIssue(apiKey, issueId, signal),
		);
	}

	async searchLinearIssues(
		userId: string,
		connectionId: string,
		query: string,
		limit: number,
		signal?: AbortSignal,
	) {
		return this.withApiCredential(
			userId,
			connectionId,
			LINEAR_CONNECTOR_ID,
			(apiKey) => this.linear.searchIssues(apiKey, query, limit, signal),
		);
	}

	async listLinearTeams(
		userId: string,
		connectionId: string,
		limit: number,
		signal?: AbortSignal,
	) {
		return this.withApiCredential(
			userId,
			connectionId,
			LINEAR_CONNECTOR_ID,
			(apiKey) => this.linear.listTeams(apiKey, limit, signal),
		);
	}

	async listLinearProjects(
		userId: string,
		connectionId: string,
		limit: number,
		signal?: AbortSignal,
	) {
		return this.withApiCredential(
			userId,
			connectionId,
			LINEAR_CONNECTOR_ID,
			(apiKey) => this.linear.listProjects(apiKey, limit, signal),
		);
	}

	async listLinearIssueComments(
		userId: string,
		connectionId: string,
		issueId: string,
		limit: number,
		signal?: AbortSignal,
	) {
		return this.withApiCredential(
			userId,
			connectionId,
			LINEAR_CONNECTOR_ID,
			(apiKey) => this.linear.listIssueComments(apiKey, issueId, limit, signal),
		);
	}

	async listStripePaymentIntents(
		userId: string,
		connectionId: string,
		limit: number,
		signal?: AbortSignal,
	) {
		return this.withApiCredential(
			userId,
			connectionId,
			STRIPE_CONNECTOR_ID,
			(apiKey) => this.stripe.listPaymentIntents(apiKey, limit, signal),
		);
	}

	async readStripePaymentIntent(
		userId: string,
		connectionId: string,
		paymentIntentId: string,
		signal?: AbortSignal,
	) {
		return this.withApiCredential(
			userId,
			connectionId,
			STRIPE_CONNECTOR_ID,
			(apiKey) =>
				this.stripe.readPaymentIntent(apiKey, paymentIntentId, signal),
		);
	}

	async searchStripePaymentIntents(
		userId: string,
		connectionId: string,
		input: { query: string; limit: number; page?: string },
		signal?: AbortSignal,
	) {
		return this.withApiCredential(
			userId,
			connectionId,
			STRIPE_CONNECTOR_ID,
			(apiKey) => this.stripe.searchPaymentIntents(apiKey, input, signal),
		);
	}
}
