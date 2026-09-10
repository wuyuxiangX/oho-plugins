import type { ConnectorId } from "../../runtime/provider-metadata.js";
import type {
	ConnectorOAuthCredential,
	ConnectorOAuthDriver,
} from "../../runtime/oauth.js";
import {
	ConnectorProviderError,
	connectorRequestSignal,
	oauthCredential,
	retryAfterMs,
} from "../../runtime/oauth.js";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_USER_AGENT = "Oho/0.0.0";
const MAX_SHEET_ROWS = 200;
const MAX_SHEET_COLUMNS = 50;
const MAX_SHEET_CELL_CHARS = 4_096;
const MAX_SHEET_BATCH_CELLS = 20_000;
const MAX_SHEET_RESPONSE_BYTES = 1024 * 1024;

type FetchLike = typeof fetch;

export type GoogleWorkspaceConnectorId =
	"google_calendar" | "google_drive" | "google_sheets";

type GoogleTokenResponse = {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	error?: string;
	error_description?: string;
};

export type GoogleCalendarEvent = {
	id: string;
	summary: string;
	description: string;
	location: string;
	start: string;
	end: string;
	status: string;
	htmlLink: string;
};

export type GoogleDriveFile = {
	id: string;
	name: string;
	mimeType: string;
	modifiedAt: string;
	webViewLink: string;
};

export type GoogleCalendarListEntry = {
	id: string;
	summary: string;
	primary: boolean;
	accessRole: string;
	timeZone: string;
};

export type GoogleDriveFileDetails = GoogleDriveFile & {
	description: string;
	createdAt: string;
	size: string;
	parents: string[];
	md5Checksum: string;
};

export type GoogleSpreadsheetMetadata = {
	id: string;
	title: string;
	locale: string;
	timeZone: string;
	sheets: Array<{
		id: number;
		title: string;
		index: number;
		rowCount: number;
		columnCount: number;
	}>;
};

type GoogleCalendarEventResource = {
	id?: string;
	summary?: string;
	description?: string;
	location?: string;
	start?: { dateTime?: string; date?: string };
	end?: { dateTime?: string; date?: string };
	status?: string;
	htmlLink?: string;
};

function mapCalendarEvent(
	event: GoogleCalendarEventResource,
): GoogleCalendarEvent | null {
	if (!event.id) return null;
	return {
		id: event.id,
		summary: (event.summary ?? "").slice(0, 1_024),
		description: (event.description ?? "").slice(0, 4_096),
		location: (event.location ?? "").slice(0, 2_048),
		start: event.start?.dateTime ?? event.start?.date ?? "",
		end: event.end?.dateTime ?? event.end?.date ?? "",
		status: (event.status ?? "").slice(0, 64),
		htmlLink: (event.htmlLink ?? "").slice(0, 2_048),
	};
}

type GoogleDriveFileResource = {
	id?: string;
	name?: string;
	mimeType?: string;
	modifiedTime?: string;
	webViewLink?: string;
	description?: string;
	createdTime?: string;
	size?: string;
	parents?: string[];
	md5Checksum?: string;
};

function mapDriveFile(file: GoogleDriveFileResource): GoogleDriveFile | null {
	if (!file.id) return null;
	return {
		id: file.id,
		name: (file.name ?? "").slice(0, 1_024),
		mimeType: (file.mimeType ?? "").slice(0, 256),
		modifiedAt: file.modifiedTime ?? "",
		webViewLink: (file.webViewLink ?? "").slice(0, 2_048),
	};
}

async function googleJson<T>(
	response: Response,
	connectorId: ConnectorId,
	maxResponseBytes?: number,
): Promise<T> {
	let body: unknown;
	if (maxResponseBytes === undefined) {
		body = await response.json().catch(() => ({}));
	} else {
		const contentLength = Number(response.headers.get("content-length"));
		if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
			throw new ConnectorProviderError(
				connectorId,
				"google_response_too_large",
				413,
				"Google response exceeded the connector payload limit",
			);
		}
		const reader = response.body?.getReader();
		const chunks: Uint8Array[] = [];
		let byteLength = 0;
		while (reader) {
			const { done, value } = await reader.read();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > maxResponseBytes) {
				await reader.cancel();
				throw new ConnectorProviderError(
					connectorId,
					"google_response_too_large",
					413,
					"Google response exceeded the connector payload limit",
				);
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(byteLength);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		try {
			body = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			body = {};
		}
	}
	const errorBody = body as {
		error?: string | { code?: number; message?: string; status?: string };
		error_description?: string;
	};
	if (!response.ok) {
		const providerCode =
			typeof errorBody.error === "string"
				? errorBody.error
				: (errorBody.error?.status ?? `google_http_${response.status}`);
		const message =
			typeof errorBody.error === "object"
				? errorBody.error.message
				: errorBody.error_description;
		throw new ConnectorProviderError(
			connectorId,
			providerCode,
			response.status,
			message ?? `Google request failed (${response.status})`,
			retryAfterMs(response),
		);
	}
	return body as T;
}

type SheetRangeBounds = { rows: number; columns: number; cells: number };

function columnNumber(label: string): number {
	let value = 0;
	for (const character of label.toUpperCase()) {
		value = value * 26 + character.charCodeAt(0) - 64;
	}
	return value;
}

function a1Coordinates(range: string): string {
	if (range.startsWith("'")) {
		let index = 1;
		while (index < range.length) {
			if (range[index] !== "'") {
				index += 1;
				continue;
			}
			if (range[index + 1] === "'") {
				index += 2;
				continue;
			}
			if (range[index + 1] === "!") return range.slice(index + 2);
			break;
		}
		return "";
	}
	const separator = range.indexOf("!");
	if (separator < 0) return range;
	if (separator === 0 || range.indexOf("!", separator + 1) >= 0) return "";
	const sheetName = range.slice(0, separator);
	if (sheetName.includes("'") || /[\u0000-\u001f]/.test(sheetName)) return "";
	return range.slice(separator + 1);
}

function parseSheetRange(range: string): SheetRangeBounds {
	const coordinates = a1Coordinates(range.trim());
	const parts = coordinates.split(":");
	if (parts.length > 2 || !parts[0]) {
		throw new ConnectorProviderError(
			"google_sheets",
			"sheet_range_invalid",
			400,
			"Google Sheets range must be an explicit A1 cell or rectangular range",
		);
	}
	const parseCell = (cell: string) => {
		const match = /^\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})$/.exec(cell);
		if (!match?.[1] || !match[2]) return null;
		return { column: columnNumber(match[1]), row: Number(match[2]) };
	};
	const start = parseCell(parts[0]);
	const end = parseCell(parts[1] ?? parts[0]);
	if (!start || !end || end.row < start.row || end.column < start.column) {
		throw new ConnectorProviderError(
			"google_sheets",
			"sheet_range_invalid",
			400,
			"Google Sheets range must be an explicit A1 cell or rectangular range",
		);
	}
	const rows = end.row - start.row + 1;
	const columns = end.column - start.column + 1;
	if (rows > MAX_SHEET_ROWS || columns > MAX_SHEET_COLUMNS) {
		throw new ConnectorProviderError(
			"google_sheets",
			"sheet_range_too_large",
			400,
			`Google Sheets ranges are limited to ${MAX_SHEET_ROWS} rows and ${MAX_SHEET_COLUMNS} columns`,
		);
	}
	return { rows, columns, cells: rows * columns };
}

function boundedSheetValueRange(
	source: unknown[][],
	fallbackRange: string,
	providerRange?: string,
) {
	let truncated = source.length > MAX_SHEET_ROWS;
	const values = source.slice(0, MAX_SHEET_ROWS).map((row) => {
		if (row.length > MAX_SHEET_COLUMNS) truncated = true;
		return row.slice(0, MAX_SHEET_COLUMNS).map((cell) => {
			const value = String(cell ?? "");
			if (value.length > MAX_SHEET_CELL_CHARS) truncated = true;
			return value.slice(0, MAX_SHEET_CELL_CHARS);
		});
	});
	return {
		range: (providerRange ?? fallbackRange).slice(0, 512),
		values,
		truncated,
	};
}

function googleHeaders(accessToken?: string): Record<string, string> {
	return {
		Accept: "application/json",
		"User-Agent": GOOGLE_USER_AGENT,
		...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
	};
}

export class GoogleWorkspaceClient implements ConnectorOAuthDriver {
	readonly pkce = "S256" as const;
	readonly requiredScopes: readonly string[];

	constructor(
		readonly connectorId: GoogleWorkspaceConnectorId,
		serviceScopes: readonly string[],
		private readonly clientId?: string,
		private readonly clientSecret?: string,
		private readonly fetchImpl: FetchLike = fetch,
		private readonly now: () => Date = () => new Date(),
	) {
		this.requiredScopes = ["openid", "email", ...serviceScopes];
	}

	get configured(): boolean {
		return Boolean(this.clientId && this.clientSecret);
	}

	authorizationUrl(input: {
		state: string;
		redirectUri: string;
		codeChallenge: string;
	}): URL {
		if (!this.clientId) {
			throw new Error(`${this.connectorId}_oauth_not_configured`);
		}
		const url = new URL(GOOGLE_AUTHORIZE_URL);
		url.searchParams.set("client_id", this.clientId);
		url.searchParams.set("redirect_uri", input.redirectUri);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("scope", this.requiredScopes.join(" "));
		url.searchParams.set("access_type", "offline");
		url.searchParams.set("prompt", "consent");
		url.searchParams.set("include_granted_scopes", "false");
		url.searchParams.set("state", input.state);
		url.searchParams.set("code_challenge", input.codeChallenge);
		url.searchParams.set("code_challenge_method", "S256");
		return url;
	}

	async exchangeCode(input: {
		code: string;
		codeVerifier: string;
		redirectUri: string;
		signal?: AbortSignal;
	}) {
		const token = await this.tokenRequest(
			{
				code: input.code,
				code_verifier: input.codeVerifier,
				grant_type: "authorization_code",
				redirect_uri: input.redirectUri,
			},
			input.signal,
		);
		if (!token.refresh_token) {
			throw new ConnectorProviderError(
				this.connectorId,
				"refresh_token_missing",
				502,
				"Google did not return an offline refresh token",
			);
		}
		const credential = this.toCredential(token);
		return {
			credential,
			account: await this.getAccount(credential.accessToken, input.signal),
		};
	}

	async refreshToken(
		credential: ConnectorOAuthCredential,
		signal?: AbortSignal,
	): Promise<ConnectorOAuthCredential> {
		if (!credential.refreshToken) {
			throw new ConnectorProviderError(
				this.connectorId,
				"refresh_token_missing",
				401,
				"Google refresh token is missing",
			);
		}
		return this.toCredential(
			await this.tokenRequest(
				{
					grant_type: "refresh_token",
					refresh_token: credential.refreshToken,
				},
				signal,
			),
			credential.scopes,
			credential.refreshToken,
		);
	}

	async getAccount(accessToken: string, signal?: AbortSignal) {
		const response = await this.fetchImpl(GOOGLE_USERINFO_URL, {
			headers: googleHeaders(accessToken),
			signal: connectorRequestSignal(signal),
		});
		const profile = await googleJson<{ sub?: string; email?: string }>(
			response,
			this.connectorId,
		);
		if (!profile.sub || !profile.email) {
			throw new ConnectorProviderError(
				this.connectorId,
				"google_identity_missing",
				502,
				"Google did not return an account identity",
			);
		}
		return { id: profile.sub, label: profile.email };
	}

	async revokeCredential(
		credential: ConnectorOAuthCredential,
		signal?: AbortSignal,
	): Promise<void> {
		const response = await this.fetchImpl(GOOGLE_REVOKE_URL, {
			method: "POST",
			headers: {
				...googleHeaders(),
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				token: credential.refreshToken ?? credential.accessToken,
			}),
			signal: connectorRequestSignal(signal),
		});
		if (!response.ok) await googleJson(response, this.connectorId);
	}

	async listCalendarEvents(
		accessToken: string,
		input: { timeMin: string; timeMax: string; limit: number },
		signal?: AbortSignal,
	): Promise<GoogleCalendarEvent[]> {
		const url = new URL(
			"https://www.googleapis.com/calendar/v3/calendars/primary/events",
		);
		url.searchParams.set("timeMin", input.timeMin);
		url.searchParams.set("timeMax", input.timeMax);
		url.searchParams.set("singleEvents", "true");
		url.searchParams.set("orderBy", "startTime");
		url.searchParams.set("maxResults", String(input.limit));
		const response = await this.fetchImpl(url, {
			headers: googleHeaders(accessToken),
			signal: connectorRequestSignal(signal),
		});
		const body = await googleJson<{
			items?: GoogleCalendarEventResource[];
		}>(response, this.connectorId);
		return (body.items ?? []).flatMap((event) => {
			const mapped = mapCalendarEvent(event);
			return mapped ? [mapped] : [];
		});
	}

	async listCalendars(
		accessToken: string,
		limit: number,
		signal?: AbortSignal,
	): Promise<GoogleCalendarListEntry[]> {
		const url = new URL(
			"https://www.googleapis.com/calendar/v3/users/me/calendarList",
		);
		url.searchParams.set("maxResults", String(limit));
		const response = await this.fetchImpl(url, {
			headers: googleHeaders(accessToken),
			signal: connectorRequestSignal(signal),
		});
		const body = await googleJson<{
			items?: Array<{
				id?: string;
				summary?: string;
				primary?: boolean;
				accessRole?: string;
				timeZone?: string;
			}>;
		}>(response, this.connectorId);
		return (body.items ?? []).flatMap((calendar) =>
			calendar.id
				? [
						{
							id: calendar.id,
							summary: (calendar.summary ?? "").slice(0, 1_024),
							primary: calendar.primary === true,
							accessRole: (calendar.accessRole ?? "").slice(0, 64),
							timeZone: (calendar.timeZone ?? "").slice(0, 128),
						},
					]
				: [],
		);
	}

	async readCalendarEvent(
		accessToken: string,
		calendarId: string,
		eventId: string,
		signal?: AbortSignal,
	): Promise<GoogleCalendarEvent> {
		const response = await this.fetchImpl(
			`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
			{
				headers: googleHeaders(accessToken),
				signal: connectorRequestSignal(signal),
			},
		);
		const mapped = mapCalendarEvent(
			await googleJson<GoogleCalendarEventResource>(response, this.connectorId),
		);
		if (!mapped) {
			throw new ConnectorProviderError(
				this.connectorId,
				"calendar_event_identity_missing",
				502,
				"Google Calendar did not return the requested event identity",
			);
		}
		return mapped;
	}

	async readCalendarFreeBusy(
		accessToken: string,
		input: {
			timeMin: string;
			timeMax: string;
			calendarIds: string[];
			timeZone?: string;
		},
		signal?: AbortSignal,
	) {
		const response = await this.fetchImpl(
			"https://www.googleapis.com/calendar/v3/freeBusy",
			{
				method: "POST",
				headers: {
					...googleHeaders(accessToken),
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					timeMin: input.timeMin,
					timeMax: input.timeMax,
					...(input.timeZone ? { timeZone: input.timeZone } : {}),
					items: input.calendarIds.map((id) => ({ id })),
				}),
				signal: connectorRequestSignal(signal),
			},
		);
		const body = await googleJson<{
			calendars?: Record<
				string,
				{
					busy?: Array<{ start?: string; end?: string }>;
					errors?: Array<{ domain?: string; reason?: string }>;
				}
			>;
		}>(response, this.connectorId);
		return Object.entries(body.calendars ?? {}).map(([id, calendar]) => ({
			id,
			busy: (calendar.busy ?? []).flatMap((period) =>
				period.start && period.end
					? [{ start: period.start, end: period.end }]
					: [],
			),
			errors: (calendar.errors ?? []).map((error) => ({
				domain: (error.domain ?? "").slice(0, 128),
				reason: (error.reason ?? "").slice(0, 256),
			})),
		}));
	}

	async searchDriveFiles(
		accessToken: string,
		query: string,
		limit: number,
		signal?: AbortSignal,
	): Promise<GoogleDriveFile[]> {
		const escaped = query.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
		const url = new URL("https://www.googleapis.com/drive/v3/files");
		url.searchParams.set("q", `trashed = false and name contains '${escaped}'`);
		url.searchParams.set("orderBy", "modifiedTime desc");
		url.searchParams.set("pageSize", String(limit));
		url.searchParams.set(
			"fields",
			"files(id,name,mimeType,modifiedTime,webViewLink)",
		);
		const response = await this.fetchImpl(url, {
			headers: googleHeaders(accessToken),
			signal: connectorRequestSignal(signal),
		});
		const body = await googleJson<{ files?: GoogleDriveFileResource[] }>(
			response,
			this.connectorId,
		);
		return (body.files ?? []).flatMap((file) => {
			const mapped = mapDriveFile(file);
			return mapped ? [mapped] : [];
		});
	}

	async readDriveFile(
		accessToken: string,
		fileId: string,
		signal?: AbortSignal,
	): Promise<GoogleDriveFileDetails> {
		const url = new URL(
			`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
		);
		url.searchParams.set(
			"fields",
			"id,name,mimeType,modifiedTime,webViewLink,description,createdTime,size,parents,md5Checksum",
		);
		const response = await this.fetchImpl(url, {
			headers: googleHeaders(accessToken),
			signal: connectorRequestSignal(signal),
		});
		const file = await googleJson<GoogleDriveFileResource>(
			response,
			this.connectorId,
		);
		const summary = mapDriveFile(file);
		if (!summary) {
			throw new ConnectorProviderError(
				this.connectorId,
				"drive_file_identity_missing",
				502,
				"Google Drive did not return the requested file identity",
			);
		}
		return {
			...summary,
			description: (file.description ?? "").slice(0, 4_096),
			createdAt: file.createdTime ?? "",
			size: file.size ?? "",
			parents: (file.parents ?? []).slice(0, 100),
			md5Checksum: (file.md5Checksum ?? "").slice(0, 128),
		};
	}

	async listDriveFolderChildren(
		accessToken: string,
		input: { folderId: string; limit: number; pageToken?: string },
		signal?: AbortSignal,
	): Promise<{ files: GoogleDriveFile[]; nextPageToken?: string }> {
		const escaped = input.folderId
			.replaceAll("\\", "\\\\")
			.replaceAll("'", "\\'");
		const url = new URL("https://www.googleapis.com/drive/v3/files");
		url.searchParams.set("q", `trashed = false and '${escaped}' in parents`);
		url.searchParams.set("orderBy", "folder,name_natural");
		url.searchParams.set("pageSize", String(input.limit));
		url.searchParams.set(
			"fields",
			"nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)",
		);
		if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
		const response = await this.fetchImpl(url, {
			headers: googleHeaders(accessToken),
			signal: connectorRequestSignal(signal),
		});
		const body = await googleJson<{
			files?: GoogleDriveFileResource[];
			nextPageToken?: string;
		}>(response, this.connectorId);
		return {
			files: (body.files ?? []).flatMap((file) => {
				const mapped = mapDriveFile(file);
				return mapped ? [mapped] : [];
			}),
			...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
		};
	}

	async readSheetValues(
		accessToken: string,
		spreadsheetId: string,
		range: string,
		signal?: AbortSignal,
	): Promise<{ range: string; values: string[][]; truncated: boolean }> {
		const normalizedRange = range.trim();
		parseSheetRange(normalizedRange);
		const url = new URL(
			`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(normalizedRange)}`,
		);
		url.searchParams.set("majorDimension", "ROWS");
		url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
		const response = await this.fetchImpl(url, {
			headers: googleHeaders(accessToken),
			signal: connectorRequestSignal(signal),
		});
		const body = await googleJson<{
			range?: string;
			values?: unknown[][];
		}>(response, this.connectorId, MAX_SHEET_RESPONSE_BYTES);
		return boundedSheetValueRange(
			body.values ?? [],
			normalizedRange,
			body.range,
		);
	}

	async readSpreadsheetMetadata(
		accessToken: string,
		spreadsheetId: string,
		signal?: AbortSignal,
	): Promise<GoogleSpreadsheetMetadata> {
		const url = new URL(
			`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`,
		);
		url.searchParams.set("includeGridData", "false");
		url.searchParams.set(
			"fields",
			"spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))",
		);
		const response = await this.fetchImpl(url, {
			headers: googleHeaders(accessToken),
			signal: connectorRequestSignal(signal),
		});
		const body = await googleJson<{
			spreadsheetId?: string;
			properties?: { title?: string; locale?: string; timeZone?: string };
			sheets?: Array<{
				properties?: {
					sheetId?: number;
					title?: string;
					index?: number;
					gridProperties?: { rowCount?: number; columnCount?: number };
				};
			}>;
		}>(response, this.connectorId);
		if (!body.spreadsheetId) {
			throw new ConnectorProviderError(
				this.connectorId,
				"spreadsheet_identity_missing",
				502,
				"Google Sheets did not return the requested spreadsheet identity",
			);
		}
		return {
			id: body.spreadsheetId,
			title: (body.properties?.title ?? "").slice(0, 1_024),
			locale: (body.properties?.locale ?? "").slice(0, 64),
			timeZone: (body.properties?.timeZone ?? "").slice(0, 128),
			sheets: (body.sheets ?? []).flatMap((sheet) =>
				typeof sheet.properties?.sheetId === "number"
					? [
							{
								id: sheet.properties.sheetId,
								title: (sheet.properties.title ?? "").slice(0, 1_024),
								index: sheet.properties.index ?? 0,
								rowCount: sheet.properties.gridProperties?.rowCount ?? 0,
								columnCount: sheet.properties.gridProperties?.columnCount ?? 0,
							},
						]
					: [],
			),
		};
	}

	async readSheetValueRanges(
		accessToken: string,
		spreadsheetId: string,
		ranges: string[],
		signal?: AbortSignal,
	) {
		const normalizedRanges = ranges.map((range) => range.trim());
		const totalCells = normalizedRanges.reduce(
			(total, range) => total + parseSheetRange(range).cells,
			0,
		);
		if (totalCells > MAX_SHEET_BATCH_CELLS) {
			throw new ConnectorProviderError(
				"google_sheets",
				"sheet_batch_too_large",
				400,
				`Google Sheets batch ranges are limited to ${MAX_SHEET_BATCH_CELLS} requested cells`,
			);
		}
		const url = new URL(
			`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet`,
		);
		for (const range of normalizedRanges)
			url.searchParams.append("ranges", range);
		url.searchParams.set("majorDimension", "ROWS");
		url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
		const response = await this.fetchImpl(url, {
			headers: googleHeaders(accessToken),
			signal: connectorRequestSignal(signal),
		});
		const body = await googleJson<{
			valueRanges?: Array<{ range?: string; values?: unknown[][] }>;
		}>(response, this.connectorId, MAX_SHEET_RESPONSE_BYTES);
		return (body.valueRanges ?? []).map((valueRange, index) =>
			boundedSheetValueRange(
				valueRange.values ?? [],
				normalizedRanges[index] ?? "",
				valueRange.range,
			),
		);
	}

	private async tokenRequest(
		values: Record<string, string>,
		signal?: AbortSignal,
	): Promise<GoogleTokenResponse> {
		if (!this.clientId || !this.clientSecret) {
			throw new Error(`${this.connectorId}_oauth_not_configured`);
		}
		const response = await this.fetchImpl(GOOGLE_TOKEN_URL, {
			method: "POST",
			headers: {
				...googleHeaders(),
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				client_id: this.clientId,
				client_secret: this.clientSecret,
				...values,
			}),
			signal: connectorRequestSignal(signal),
		});
		const token = await googleJson<GoogleTokenResponse>(
			response,
			this.connectorId,
		);
		if (!token.access_token) {
			throw new ConnectorProviderError(
				this.connectorId,
				"access_token_missing",
				502,
				"Google did not return an access token",
			);
		}
		return token;
	}

	private toCredential(
		token: GoogleTokenResponse,
		fallbackScopes: readonly string[] = [],
		fallbackRefreshToken?: string,
	): ConnectorOAuthCredential {
		const scopes = token.scope ? token.scope.split(/\s+/).filter(Boolean) : fallbackScopes;
		return oauthCredential({
			connectorId: this.connectorId,
			accessToken: token.access_token as string,
			refreshToken: token.refresh_token ?? fallbackRefreshToken,
			expiresIn: token.expires_in,
			// Google may return the canonical URL for the requested email scope.
			scopes: scopes.map((scope) => scope === "https://www.googleapis.com/auth/userinfo.email" ? "email" : scope),
			now: this.now(),
		});
	}
}
