import { GITHUB_SCOPES } from "../../../../runtime/provider-metadata.js";
import type {
	ConnectorOAuthCredential,
	ConnectorOAuthDriver,
} from "../../../../runtime/oauth.js";
import {
	ConnectorProviderError,
	connectorRequestSignal,
	oauthCredential,
	retryAfterMs,
} from "../../../../runtime/oauth.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_USER_AGENT = "Oho/0.0.0";
const MAX_BODY_CHARS = 32_768;
const MAX_COMMENT_CHARS = 8_192;
const MAX_PATCH_CHARS = 8_192;
const MAX_FILE_BYTES = 65_536;

type FetchLike = typeof fetch;

type GitHubTokenResponse = {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	refresh_token_expires_in?: number;
	scope?: string;
	error?: string;
	error_description?: string;
};

type GitHubRepositoryResponse = {
	id: number;
	name: string;
	full_name: string;
	description: string | null;
	html_url: string;
	private: boolean;
	updated_at: string;
	language: string | null;
	default_branch?: string;
	stargazers_count?: number;
	forks_count?: number;
	open_issues_count?: number;
};

type GitHubIssueResponse = {
	id: number;
	number: number;
	title: string;
	body: string | null;
	html_url: string;
	state: "open" | "closed";
	state_reason?: string | null;
	created_at: string;
	updated_at: string;
	closed_at: string | null;
	user: { login: string } | null;
	labels: Array<string | { name?: string }>;
	pull_request?: unknown;
};

type GitHubPullRequestResponse = {
	id: number;
	number: number;
	title: string;
	body: string | null;
	html_url: string;
	state: "open" | "closed";
	draft: boolean;
	created_at: string;
	updated_at: string;
	closed_at: string | null;
	merged_at: string | null;
	user: { login: string } | null;
	base: { ref: string };
	head: { ref: string };
};

type GitHubCommitResponse = {
	sha: string;
	html_url: string;
	commit: {
		message: string;
		author: { name?: string; date?: string } | null;
	};
	author?: { login?: string } | null;
	stats?: { additions: number; deletions: number; total: number };
	files?: GitHubChangedFileResponse[];
};

type GitHubChangedFileResponse = {
	sha: string;
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	changes: number;
	patch?: string;
};

export type GitHubPage<T> = {
	items: T[];
	page: number;
	hasMore: boolean;
};

export type GitHubRepository = {
	id: string;
	name: string;
	fullName: string;
	description: string;
	url: string;
	updatedAt: string;
	language?: string;
	defaultBranch?: string;
	stars?: number;
	forks?: number;
	openIssues?: number;
};

export type GitHubContentEntry = {
	name: string;
	path: string;
	type: "file" | "dir" | "symlink" | "submodule";
	sha: string;
	size: number;
	url: string;
};

export type GitHubFile = {
	path: string;
	sha: string;
	size: number;
	content: string;
	url: string;
};

export type GitHubIssueSummary = {
	id: string;
	number: number;
	title: string;
	url: string;
	state: "open" | "closed";
	author?: string;
	labels: string[];
	createdAt: string;
	updatedAt: string;
	closedAt?: string;
	stateReason?: string;
};

export type GitHubIssue = GitHubIssueSummary & { body: string };

export type GitHubComment = {
	id: string;
	author?: string;
	body: string;
	url: string;
	createdAt: string;
	updatedAt: string;
};

export type GitHubPullRequestSummary = {
	id: string;
	number: number;
	title: string;
	url: string;
	state: "open" | "closed";
	draft: boolean;
	author?: string;
	baseRef: string;
	headRef: string;
	createdAt: string;
	updatedAt: string;
	closedAt?: string;
	mergedAt?: string;
};

export type GitHubPullRequest = GitHubPullRequestSummary & { body: string };

export type GitHubChangedFile = {
	sha: string;
	path: string;
	status: string;
	additions: number;
	deletions: number;
	changes: number;
	patch?: string;
};

export type GitHubCommitSummary = {
	sha: string;
	message: string;
	url: string;
	author?: string;
	authoredAt?: string;
};

export type GitHubCommit = GitHubCommitSummary & {
	stats?: { additions: number; deletions: number; total: number };
	files: GitHubChangedFile[];
	filesTruncated: boolean;
};

export type GitHubBranch = {
	name: string;
	sha: string;
	protected: boolean;
};

export type GitHubRelease = {
	id: string;
	name: string;
	tagName: string;
	url: string;
	draft: boolean;
	prerelease: boolean;
	createdAt: string;
	publishedAt?: string;
};

async function githubJson<T>(response: Response): Promise<T> {
	const body = (await response.json().catch(() => ({}))) as {
		message?: string;
		documentation_url?: string;
	};
	if (!response.ok) {
		const rateLimited =
			(response.status === 403 || response.status === 429) &&
			(response.status === 429 ||
				response.headers.get("x-ratelimit-remaining") === "0");
		const resetAt = Number(response.headers.get("x-ratelimit-reset"));
		const resetDelay = Number.isFinite(resetAt)
			? Math.max(0, resetAt * 1_000 - Date.now())
			: undefined;
		throw new ConnectorProviderError(
			"github",
			response.status === 401
				? "invalid_token"
				: rateLimited
					? "rate_limited"
					: `github_http_${response.status}`,
			rateLimited ? 429 : response.status,
			body.message ?? `GitHub request failed (${response.status})`,
			rateLimited
				? (retryAfterMs(response) ?? resetDelay)
				: retryAfterMs(response),
		);
	}
	return body as T;
}

function githubHeaders(accessToken?: string): Record<string, string> {
	return {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
		"User-Agent": GITHUB_USER_AGENT,
		...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
	};
}

function hasNextPage(response: Response): boolean {
	return /<[^>]+>;\s*rel="next"/.test(response.headers.get("link") ?? "");
}

function githubPage<T>(
	items: T[],
	page: number,
	response: Response,
): GitHubPage<T> {
	return { items, page, hasMore: hasNextPage(response) };
}

function rejectUnexpectedScopes(scopes: readonly string[]): void {
	const allowed = new Set<string>(GITHUB_SCOPES);
	const unexpected = scopes.filter((scope) => !allowed.has(scope));
	if (unexpected.length === 0) return;
	throw new ConnectorProviderError(
		"github",
		"github_scope_not_allowed",
		403,
		"GitHub granted scopes beyond this connector's public read-only contract",
	);
}

function mapRepository(repository: GitHubRepositoryResponse): GitHubRepository {
	return {
		id: String(repository.id),
		name: repository.name.slice(0, 256),
		fullName: repository.full_name.slice(0, 512),
		description: (repository.description ?? "").slice(0, 4_096),
		url: repository.html_url.slice(0, 2_048),
		updatedAt: repository.updated_at,
		...(repository.language
			? { language: repository.language.slice(0, 128) }
			: {}),
		...(repository.default_branch
			? { defaultBranch: repository.default_branch.slice(0, 256) }
			: {}),
		...(repository.stargazers_count === undefined
			? {}
			: { stars: repository.stargazers_count }),
		...(repository.forks_count === undefined
			? {}
			: { forks: repository.forks_count }),
		...(repository.open_issues_count === undefined
			? {}
			: { openIssues: repository.open_issues_count }),
	};
}

function issueLabels(labels: GitHubIssueResponse["labels"]): string[] {
	return labels
		.map((label) => (typeof label === "string" ? label : label.name))
		.filter((label): label is string => Boolean(label))
		.slice(0, 20)
		.map((label) => label.slice(0, 256));
}

function mapIssue(issue: GitHubIssueResponse): GitHubIssueSummary {
	return {
		id: String(issue.id),
		number: issue.number,
		title: issue.title.slice(0, 512),
		url: issue.html_url.slice(0, 2_048),
		state: issue.state,
		...(issue.user?.login ? { author: issue.user.login.slice(0, 256) } : {}),
		labels: issueLabels(issue.labels),
		createdAt: issue.created_at,
		updatedAt: issue.updated_at,
		...(issue.closed_at ? { closedAt: issue.closed_at } : {}),
		...(issue.state_reason
			? { stateReason: issue.state_reason.slice(0, 128) }
			: {}),
	};
}

function mapPullRequest(
	pullRequest: GitHubPullRequestResponse,
): GitHubPullRequestSummary {
	return {
		id: String(pullRequest.id),
		number: pullRequest.number,
		title: pullRequest.title.slice(0, 512),
		url: pullRequest.html_url.slice(0, 2_048),
		state: pullRequest.state,
		draft: pullRequest.draft,
		...(pullRequest.user?.login
			? { author: pullRequest.user.login.slice(0, 256) }
			: {}),
		baseRef: pullRequest.base.ref.slice(0, 256),
		headRef: pullRequest.head.ref.slice(0, 256),
		createdAt: pullRequest.created_at,
		updatedAt: pullRequest.updated_at,
		...(pullRequest.closed_at ? { closedAt: pullRequest.closed_at } : {}),
		...(pullRequest.merged_at ? { mergedAt: pullRequest.merged_at } : {}),
	};
}

function mapChangedFile(file: GitHubChangedFileResponse): GitHubChangedFile {
	return {
		sha: file.sha.slice(0, 64),
		path: file.filename.slice(0, 1_024),
		status: file.status.slice(0, 64),
		additions: file.additions,
		deletions: file.deletions,
		changes: file.changes,
		...(file.patch ? { patch: file.patch.slice(0, MAX_PATCH_CHARS) } : {}),
	};
}

function mapCommit(commit: GitHubCommitResponse): GitHubCommitSummary {
	return {
		sha: commit.sha.slice(0, 64),
		message: commit.commit.message.slice(0, 4_096),
		url: commit.html_url.slice(0, 2_048),
		...(commit.author?.login || commit.commit.author?.name
			? {
					author: (
						commit.author?.login ??
						commit.commit.author?.name ??
						""
					).slice(0, 256),
				}
			: {}),
		...(commit.commit.author?.date
			? { authoredAt: commit.commit.author.date }
			: {}),
	};
}

export class GitHubClient implements ConnectorOAuthDriver {
	readonly connectorId = "github" as const;
	readonly pkce = "S256" as const;
	readonly requiredScopes = GITHUB_SCOPES;

	constructor(
		private readonly clientId?: string,
		private readonly clientSecret?: string,
		private readonly fetchImpl: FetchLike = fetch,
		private readonly now: () => Date = () => new Date(),
	) {}

	get configured(): boolean {
		return Boolean(this.clientId && this.clientSecret);
	}

	authorizationUrl(input: {
		state: string;
		redirectUri: string;
		codeChallenge: string;
	}): URL {
		if (!this.clientId) throw new Error("github_oauth_not_configured");
		const url = new URL(GITHUB_AUTHORIZE_URL);
		url.searchParams.set("client_id", this.clientId);
		url.searchParams.set("redirect_uri", input.redirectUri);
		url.searchParams.set("scope", this.requiredScopes.join(" "));
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
				grant_type: "authorization_code",
				code: input.code,
				redirect_uri: input.redirectUri,
				code_verifier: input.codeVerifier,
			},
			input.signal,
		);
		return {
			credential: this.toCredential(token),
			account: await this.getAccount(
				token.access_token as string,
				input.signal,
			),
		};
	}

	async refreshToken(
		credential: {
			refreshToken?: string;
			scopes: string[];
		},
		signal?: AbortSignal,
	) {
		if (!credential.refreshToken) {
			throw new ConnectorProviderError(
				"github",
				"refresh_token_missing",
				401,
				"GitHub refresh token is missing",
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
		);
	}

	async getAccount(accessToken: string, signal?: AbortSignal) {
		const { data } = await this.get<{ id: number; login: string }>(
			accessToken,
			"/user",
			undefined,
			signal,
		);
		return { id: String(data.id), label: data.login };
	}

	async listPublicRepositories(
		accessToken: string,
		input: { limit: number; page: number },
		signal?: AbortSignal,
	): Promise<GitHubPage<GitHubRepository>> {
		const { data, response } = await this.get<GitHubRepositoryResponse[]>(
			accessToken,
			"/user/repos",
			{
				visibility: "public",
				affiliation: "owner,collaborator,organization_member",
				sort: "updated",
				per_page: input.limit,
				page: input.page,
			},
			signal,
		);
		return githubPage(
			data.filter((repository) => !repository.private).map(mapRepository),
			input.page,
			response,
		);
	}

	async searchPublicRepositories(
		accessToken: string,
		input: { query: string; limit: number; page: number },
		signal?: AbortSignal,
	): Promise<GitHubPage<GitHubRepository>> {
		const { data, response } = await this.get<{
			items: GitHubRepositoryResponse[];
		}>(
			accessToken,
			"/search/repositories",
			{
				q: `${input.query} is:public`,
				per_page: input.limit,
				page: input.page,
			},
			signal,
		);
		return githubPage(
			data.items.filter((repository) => !repository.private).map(mapRepository),
			input.page,
			response,
		);
	}

	async getPublicRepository(
		accessToken: string,
		owner: string,
		repository: string,
		signal?: AbortSignal,
	): Promise<GitHubRepository> {
		return mapRepository(
			await this.publicRepository(accessToken, owner, repository, signal),
		);
	}

	async listPublicRepositoryContents(
		accessToken: string,
		input: {
			owner: string;
			repository: string;
			path: string;
			ref?: string;
			limit: number;
		},
		signal?: AbortSignal,
	): Promise<{ entries: GitHubContentEntry[]; truncated: boolean }> {
		await this.publicRepository(
			accessToken,
			input.owner,
			input.repository,
			signal,
		);
		const suffix = input.path
			? `/contents/${input.path.split("/").map(encodeURIComponent).join("/")}`
			: "/contents";
		const { data } = await this.get<
			| Array<{
					name: string;
					path: string;
					type: GitHubContentEntry["type"];
					sha: string;
					size: number;
					html_url: string | null;
			  }>
			| { type: string }
		>(
			accessToken,
			`${this.repositoryPath(input.owner, input.repository)}${suffix}`,
			input.ref ? { ref: input.ref } : undefined,
			signal,
		);
		if (!Array.isArray(data)) {
			throw new ConnectorProviderError(
				"github",
				"github_path_not_directory",
				400,
				"GitHub path is not a directory",
			);
		}
		return {
			entries: data.slice(0, input.limit).map((entry) => ({
				name: entry.name.slice(0, 256),
				path: entry.path.slice(0, 1_024),
				type: entry.type,
				sha: entry.sha.slice(0, 64),
				size: entry.size,
				url: (entry.html_url ?? "https://github.com").slice(0, 2_048),
			})),
			truncated: data.length > input.limit,
		};
	}

	async readPublicRepositoryFile(
		accessToken: string,
		input: { owner: string; repository: string; path: string; ref?: string },
		signal?: AbortSignal,
	): Promise<GitHubFile> {
		await this.publicRepository(
			accessToken,
			input.owner,
			input.repository,
			signal,
		);
		const suffix = input.path.split("/").map(encodeURIComponent).join("/");
		const { data } = await this.get<{
			type: string;
			path: string;
			sha: string;
			size: number;
			encoding?: string;
			content?: string;
			html_url: string | null;
		}>(
			accessToken,
			`${this.repositoryPath(input.owner, input.repository)}/contents/${suffix}`,
			input.ref ? { ref: input.ref } : undefined,
			signal,
		);
		if (
			data.type !== "file" ||
			data.encoding !== "base64" ||
			!data.content ||
			data.size > MAX_FILE_BYTES
		) {
			throw new ConnectorProviderError(
				"github",
				"github_file_not_supported",
				413,
				"GitHub file must be UTF-8 text no larger than 64 KiB",
			);
		}
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(
				Buffer.from(data.content.replace(/\s/g, ""), "base64"),
			);
		} catch {
			throw new ConnectorProviderError(
				"github",
				"github_file_not_utf8",
				415,
				"GitHub file is not valid UTF-8 text",
			);
		}
		return {
			path: data.path.slice(0, 1_024),
			sha: data.sha.slice(0, 64),
			size: data.size,
			content,
			url: (data.html_url ?? "https://github.com").slice(0, 2_048),
		};
	}

	async listIssues(
		accessToken: string,
		input: {
			owner: string;
			repository: string;
			state: "open" | "closed" | "all";
			limit: number;
			page: number;
		},
		signal?: AbortSignal,
	): Promise<GitHubPage<GitHubIssueSummary>> {
		await this.publicRepository(
			accessToken,
			input.owner,
			input.repository,
			signal,
		);
		const qualifiers = [
			`repo:${input.owner}/${input.repository}`,
			"is:issue",
			...(input.state === "all" ? [] : [`is:${input.state}`]),
		];
		const { data, response } = await this.get<{
			items: GitHubIssueResponse[];
		}>(
			accessToken,
			"/search/issues",
			{ q: qualifiers.join(" "), per_page: input.limit, page: input.page },
			signal,
		);
		return githubPage(
			data.items.filter((issue) => !issue.pull_request).map(mapIssue),
			input.page,
			response,
		);
	}

	async getIssue(
		accessToken: string,
		input: { owner: string; repository: string; number: number },
		signal?: AbortSignal,
	): Promise<GitHubIssue> {
		await this.publicRepository(
			accessToken,
			input.owner,
			input.repository,
			signal,
		);
		const { data } = await this.get<GitHubIssueResponse>(
			accessToken,
			`${this.repositoryPath(input.owner, input.repository)}/issues/${input.number}`,
			undefined,
			signal,
		);
		if (data.pull_request) {
			throw new ConnectorProviderError(
				"github",
				"github_issue_is_pull_request",
				400,
				"GitHub number identifies a pull request, not an issue",
			);
		}
		return {
			...mapIssue(data),
			body: (data.body ?? "").slice(0, MAX_BODY_CHARS),
		};
	}

	async listIssueComments(
		accessToken: string,
		input: {
			owner: string;
			repository: string;
			number: number;
			limit: number;
			page: number;
		},
		signal?: AbortSignal,
	): Promise<GitHubPage<GitHubComment>> {
		await this.publicRepository(
			accessToken,
			input.owner,
			input.repository,
			signal,
		);
		const { data, response } = await this.get<
			Array<{
				id: number;
				user: { login: string } | null;
				body: string | null;
				html_url: string;
				created_at: string;
				updated_at: string;
			}>
		>(
			accessToken,
			`${this.repositoryPath(input.owner, input.repository)}/issues/${input.number}/comments`,
			{ per_page: input.limit, page: input.page },
			signal,
		);
		return githubPage(
			data.map((comment) => ({
				id: String(comment.id),
				...(comment.user?.login
					? { author: comment.user.login.slice(0, 256) }
					: {}),
				body: (comment.body ?? "").slice(0, MAX_COMMENT_CHARS),
				url: comment.html_url.slice(0, 2_048),
				createdAt: comment.created_at,
				updatedAt: comment.updated_at,
			})),
			input.page,
			response,
		);
	}

	async listPullRequests(
		accessToken: string,
		input: {
			owner: string;
			repository: string;
			state: "open" | "closed" | "all";
			limit: number;
			page: number;
		},
		signal?: AbortSignal,
	): Promise<GitHubPage<GitHubPullRequestSummary>> {
		await this.publicRepository(
			accessToken,
			input.owner,
			input.repository,
			signal,
		);
		const { data, response } = await this.get<GitHubPullRequestResponse[]>(
			accessToken,
			`${this.repositoryPath(input.owner, input.repository)}/pulls`,
			{ state: input.state, per_page: input.limit, page: input.page },
			signal,
		);
		return githubPage(data.map(mapPullRequest), input.page, response);
	}

	async getPullRequest(
		accessToken: string,
		input: { owner: string; repository: string; number: number },
		signal?: AbortSignal,
	): Promise<GitHubPullRequest> {
		await this.publicRepository(
			accessToken,
			input.owner,
			input.repository,
			signal,
		);
		const { data } = await this.get<GitHubPullRequestResponse>(
			accessToken,
			`${this.repositoryPath(input.owner, input.repository)}/pulls/${input.number}`,
			undefined,
			signal,
		);
		return {
			...mapPullRequest(data),
			body: (data.body ?? "").slice(0, MAX_BODY_CHARS),
		};
	}

	async listPullRequestFiles(
		accessToken: string,
		input: {
			owner: string;
			repository: string;
			number: number;
			limit: number;
			page: number;
		},
		signal?: AbortSignal,
	): Promise<GitHubPage<GitHubChangedFile>> {
		await this.publicRepository(
			accessToken,
			input.owner,
			input.repository,
			signal,
		);
		const { data, response } = await this.get<GitHubChangedFileResponse[]>(
			accessToken,
			`${this.repositoryPath(input.owner, input.repository)}/pulls/${input.number}/files`,
			{ per_page: input.limit, page: input.page },
			signal,
		);
		return githubPage(data.map(mapChangedFile), input.page, response);
	}

	async listCommits(
		accessToken: string,
		input: {
			owner: string;
			repository: string;
			ref?: string;
			limit: number;
			page: number;
		},
		signal?: AbortSignal,
	): Promise<GitHubPage<GitHubCommitSummary>> {
		await this.publicRepository(
			accessToken,
			input.owner,
			input.repository,
			signal,
		);
		const { data, response } = await this.get<GitHubCommitResponse[]>(
			accessToken,
			`${this.repositoryPath(input.owner, input.repository)}/commits`,
			{
				...(input.ref ? { sha: input.ref } : {}),
				per_page: input.limit,
				page: input.page,
			},
			signal,
		);
		return githubPage(data.map(mapCommit), input.page, response);
	}

	async getCommit(
		accessToken: string,
		input: { owner: string; repository: string; ref: string },
		signal?: AbortSignal,
	): Promise<GitHubCommit> {
		await this.publicRepository(
			accessToken,
			input.owner,
			input.repository,
			signal,
		);
		const { data } = await this.get<GitHubCommitResponse>(
			accessToken,
			`${this.repositoryPath(input.owner, input.repository)}/commits/${encodeURIComponent(input.ref)}`,
			undefined,
			signal,
		);
		const files = data.files ?? [];
		return {
			...mapCommit(data),
			...(data.stats ? { stats: data.stats } : {}),
			files: files.slice(0, 20).map(mapChangedFile),
			filesTruncated: files.length > 20,
		};
	}

	async listBranches(
		accessToken: string,
		input: { owner: string; repository: string; limit: number; page: number },
		signal?: AbortSignal,
	): Promise<GitHubPage<GitHubBranch>> {
		await this.publicRepository(
			accessToken,
			input.owner,
			input.repository,
			signal,
		);
		const { data, response } = await this.get<
			Array<{ name: string; commit: { sha: string }; protected: boolean }>
		>(
			accessToken,
			`${this.repositoryPath(input.owner, input.repository)}/branches`,
			{ per_page: input.limit, page: input.page },
			signal,
		);
		return githubPage(
			data.map((branch) => ({
				name: branch.name.slice(0, 256),
				sha: branch.commit.sha.slice(0, 64),
				protected: branch.protected,
			})),
			input.page,
			response,
		);
	}

	async listReleases(
		accessToken: string,
		input: { owner: string; repository: string; limit: number; page: number },
		signal?: AbortSignal,
	): Promise<GitHubPage<GitHubRelease>> {
		await this.publicRepository(
			accessToken,
			input.owner,
			input.repository,
			signal,
		);
		const { data, response } = await this.get<
			Array<{
				id: number;
				name: string | null;
				tag_name: string;
				html_url: string;
				draft: boolean;
				prerelease: boolean;
				created_at: string;
				published_at: string | null;
			}>
		>(
			accessToken,
			`${this.repositoryPath(input.owner, input.repository)}/releases`,
			{ per_page: input.limit, page: input.page },
			signal,
		);
		return githubPage(
			data.map((release) => ({
				id: String(release.id),
				name: (release.name ?? release.tag_name).slice(0, 512),
				tagName: release.tag_name.slice(0, 256),
				url: release.html_url.slice(0, 2_048),
				draft: release.draft,
				prerelease: release.prerelease,
				createdAt: release.created_at,
				...(release.published_at ? { publishedAt: release.published_at } : {}),
			})),
			input.page,
			response,
		);
	}

	async revokeCredential(
		credential: ConnectorOAuthCredential,
		signal?: AbortSignal,
	): Promise<void> {
		if (!this.clientId || !this.clientSecret) return;
		const response = await this.fetchImpl(
			`${GITHUB_API}/applications/${encodeURIComponent(this.clientId)}/token`,
			{
				method: "DELETE",
				headers: {
					...githubHeaders(),
					Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ access_token: credential.accessToken }),
				signal: connectorRequestSignal(signal),
			},
		);
		if (!response.ok && response.status !== 404) await githubJson(response);
	}

	private async get<T>(
		accessToken: string,
		path: string,
		query: Record<string, string | number> | undefined,
		signal?: AbortSignal,
	): Promise<{ data: T; response: Response }> {
		const url = new URL(`${GITHUB_API}${path}`);
		for (const [key, value] of Object.entries(query ?? {})) {
			url.searchParams.set(key, String(value));
		}
		const response = await this.fetchImpl(url, {
			headers: githubHeaders(accessToken),
			signal: connectorRequestSignal(signal),
		});
		const grantedScopes = response.headers.get("x-oauth-scopes");
		if (grantedScopes !== null) {
			rejectUnexpectedScopes(
				grantedScopes
					.split(",")
					.map((scope) => scope.trim())
					.filter(Boolean),
			);
		}
		return { data: await githubJson<T>(response), response };
	}

	private repositoryPath(owner: string, repository: string): string {
		return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
	}

	private async publicRepository(
		accessToken: string,
		owner: string,
		repository: string,
		signal?: AbortSignal,
	): Promise<GitHubRepositoryResponse> {
		const { data } = await this.get<GitHubRepositoryResponse>(
			accessToken,
			this.repositoryPath(owner, repository),
			undefined,
			signal,
		);
		this.requirePublicRepository(data);
		return data;
	}

	private requirePublicRepository(repository: GitHubRepositoryResponse): void {
		if (!repository.private) return;
		throw new ConnectorProviderError(
			"github",
			"github_private_repository_not_available",
			404,
			"Private GitHub repositories are not available to this connector",
		);
	}

	private async tokenRequest(
		values: Record<string, string>,
		signal?: AbortSignal,
	): Promise<GitHubTokenResponse> {
		if (!this.clientId || !this.clientSecret) {
			throw new Error("github_oauth_not_configured");
		}
		const response = await this.fetchImpl(GITHUB_TOKEN_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
				"User-Agent": GITHUB_USER_AGENT,
			},
			body: new URLSearchParams({
				client_id: this.clientId,
				client_secret: this.clientSecret,
				...values,
			}),
			signal: connectorRequestSignal(signal),
		});
		const body = (await response
			.json()
			.catch(() => ({}))) as GitHubTokenResponse;
		if (!response.ok || body.error || !body.access_token) {
			throw new ConnectorProviderError(
				"github",
				body.error ?? `github_oauth_http_${response.status}`,
				response.status,
				body.error_description ?? "GitHub OAuth token exchange failed",
				retryAfterMs(response),
			);
		}
		return body;
	}

	private toCredential(
		token: GitHubTokenResponse,
		fallbackScopes: readonly string[] = [],
	) {
		const scopes = token.scope
			? token.scope
					.split(",")
					.map((scope) => scope.trim())
					.filter(Boolean)
			: [...fallbackScopes];
		rejectUnexpectedScopes(scopes);
		return oauthCredential({
			connectorId: this.connectorId,
			accessToken: token.access_token as string,
			refreshToken: token.refresh_token,
			expiresIn: token.expires_in,
			refreshTokenExpiresIn: token.refresh_token_expires_in,
			scopes,
			now: this.now(),
		});
	}
}
