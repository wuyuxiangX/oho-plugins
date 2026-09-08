export type ConnectorId =
	| "github"
	| "gmail"
	| "slack"
	| "notion"
	| "feishu"
	| "lark"
	| "google_calendar"
	| "google_drive"
	| "google_sheets"
	| "linear"
	| "stripe"
	| "resend";
export const GMAIL_CONNECTOR_ID = "gmail" as const;
export const GMAIL_CONNECTOR_VERSION = "1.1.0" as const;
export const RESEND_CONNECTOR_ID = "resend" as const;
export const RESEND_CONNECTOR_VERSION = "1.0.0" as const;
export const GITHUB_CONNECTOR_ID = "github" as const;
export const SLACK_CONNECTOR_ID = "slack" as const;
export const NOTION_CONNECTOR_ID = "notion" as const;
export const FEISHU_CONNECTOR_ID = "feishu" as const;
export const LARK_CONNECTOR_ID = "lark" as const;
export const GOOGLE_CALENDAR_CONNECTOR_ID = "google_calendar" as const;
export const GOOGLE_DRIVE_CONNECTOR_ID = "google_drive" as const;
export const GOOGLE_SHEETS_CONNECTOR_ID = "google_sheets" as const;
export const LINEAR_CONNECTOR_ID = "linear" as const;
export const STRIPE_CONNECTOR_ID = "stripe" as const;

export const GITHUB_SCOPES = ["read:user"] as const;
export const SLACK_SCOPES = [
	"channels:read",
	"channels:history",
	"chat:write",
] as const;
export const NOTION_SCOPES = [] as const;
export const LARK_SCOPES = ["offline_access", "task:task:read"] as const;
export const GOOGLE_CALENDAR_SCOPES = [
	"https://www.googleapis.com/auth/calendar.readonly",
] as const;
export const GOOGLE_DRIVE_SCOPES = [
	"https://www.googleapis.com/auth/drive.metadata.readonly",
] as const;
export const GOOGLE_SHEETS_SCOPES = [
	"https://www.googleapis.com/auth/spreadsheets.readonly",
] as const;

export const GMAIL_SCOPES = [
	"https://www.googleapis.com/auth/gmail.readonly",
	"https://www.googleapis.com/auth/gmail.compose",
] as const;
