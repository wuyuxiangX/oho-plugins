import {
	ConnectorProviderError,
	connectorRequestSignal,
	retryAfterMs,
} from "../../../../runtime/oauth.js";

const LINEAR_API = "https://api.linear.app/graphql";
const LINEAR_USER_AGENT = "Oho/0.0.0";

type FetchLike = typeof fetch;

type LinearEnvelope<T> = {
	data?: T;
	errors?: Array<{
		message?: string;
		extensions?: { code?: string; statusCode?: number };
	}>;
};

export type LinearIssue = {
	id: string;
	identifier: string;
	title: string;
	url: string;
	priority: number;
	state: string;
	team: string;
	updatedAt: string;
};

export type LinearIssueDetails = LinearIssue & {
	description: string;
	assignee: string;
	project: string;
	labels: string[];
	createdAt: string;
	dueDate: string;
};

type LinearIssueResource = {
	id?: string;
	identifier?: string;
	title?: string;
	url?: string;
	priority?: number;
	state?: { name?: string };
	team?: { name?: string };
	updatedAt?: string;
};

function mapIssue(issue: LinearIssueResource): LinearIssue | null {
	if (!issue.id || !issue.identifier) return null;
	return {
		id: issue.id,
		identifier: issue.identifier.slice(0, 128),
		title: (issue.title ?? "").slice(0, 2_000),
		url: (issue.url ?? "").slice(0, 2_048),
		priority: issue.priority ?? 0,
		state: (issue.state?.name ?? "").slice(0, 256),
		team: (issue.team?.name ?? "").slice(0, 256),
		updatedAt: issue.updatedAt ?? "",
	};
}

export class LinearClient {
	constructor(private readonly fetchImpl: FetchLike = fetch) {}

	private async graphql<T>(
		apiKey: string,
		query: string,
		variables: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<T> {
		const response = await this.fetchImpl(LINEAR_API, {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: apiKey,
				"Content-Type": "application/json",
				"User-Agent": LINEAR_USER_AGENT,
			},
			body: JSON.stringify({ query, variables }),
			signal: connectorRequestSignal(signal),
		});
		const body = (await response.json().catch(() => ({}))) as LinearEnvelope<T>;
		const firstError = body.errors?.[0];
		if (!response.ok || firstError || !body.data) {
			const status =
				firstError?.extensions?.statusCode ??
				(response.ok ? 400 : response.status);
			throw new ConnectorProviderError(
				"linear",
				firstError?.extensions?.code ?? `linear_http_${status}`,
				status,
				firstError?.message ?? `Linear request failed (${status})`,
				retryAfterMs(response),
			);
		}
		return body.data;
	}

	async validateApiKey(apiKey: string, signal?: AbortSignal) {
		const data = await this.graphql<{
			viewer?: {
				id?: string;
				name?: string;
				email?: string;
				organization?: { id?: string; name?: string };
			};
		}>(
			apiKey,
			"query OhoConnectorIdentity { viewer { id name email organization { id name } } }",
			{},
			signal,
		);
		if (!data.viewer?.id) {
			throw new ConnectorProviderError(
				"linear",
				"linear_identity_missing",
				502,
				"Linear did not return an account identity",
			);
		}
		return {
			id: data.viewer.organization?.id ?? data.viewer.id,
			label:
				data.viewer.organization?.name ??
				data.viewer.email ??
				data.viewer.name ??
				data.viewer.id,
		};
	}

	async listIssues(
		apiKey: string,
		limit: number,
		signal?: AbortSignal,
	): Promise<LinearIssue[]> {
		const data = await this.graphql<{
			issues?: {
				nodes?: LinearIssueResource[];
			};
		}>(
			apiKey,
			"query OhoConnectorIssues($first: Int!) { issues(first: $first, orderBy: updatedAt) { nodes { id identifier title url priority state { name } team { name } updatedAt } } }",
			{ first: limit },
			signal,
		);
		return (data.issues?.nodes ?? []).flatMap((issue) => {
			const mapped = mapIssue(issue);
			return mapped ? [mapped] : [];
		});
	}

	async readIssue(
		apiKey: string,
		issueId: string,
		signal?: AbortSignal,
	): Promise<LinearIssueDetails> {
		const data = await this.graphql<{
			issue?: LinearIssueResource & {
				description?: string;
				assignee?: { name?: string };
				project?: { name?: string };
				labels?: { nodes?: Array<{ name?: string }> };
				createdAt?: string;
				dueDate?: string;
			};
		}>(
			apiKey,
			"query OhoConnectorIssue($id: String!) { issue(id: $id) { id identifier title url priority description state { name } team { name } assignee { name } project { name } labels { nodes { name } } createdAt updatedAt dueDate } }",
			{ id: issueId },
			signal,
		);
		const summary = data.issue ? mapIssue(data.issue) : null;
		if (!data.issue || !summary) {
			throw new ConnectorProviderError(
				"linear",
				"linear_issue_identity_missing",
				502,
				"Linear did not return the requested issue identity",
			);
		}
		return {
			...summary,
			description: (data.issue.description ?? "").slice(0, 32 * 1_024),
			assignee: (data.issue.assignee?.name ?? "").slice(0, 256),
			project: (data.issue.project?.name ?? "").slice(0, 256),
			labels: (data.issue.labels?.nodes ?? [])
				.flatMap((label) => (label.name ? [label.name.slice(0, 256)] : []))
				.slice(0, 100),
			createdAt: data.issue.createdAt ?? "",
			dueDate: data.issue.dueDate ?? "",
		};
	}

	async searchIssues(
		apiKey: string,
		query: string,
		limit: number,
		signal?: AbortSignal,
	): Promise<LinearIssue[]> {
		const data = await this.graphql<{
			issueSearch?: { nodes?: LinearIssueResource[] };
		}>(
			apiKey,
			"query OhoConnectorIssueSearch($query: String!, $first: Int!) { issueSearch(query: $query, first: $first) { nodes { id identifier title url priority state { name } team { name } updatedAt } } }",
			{ query, first: limit },
			signal,
		);
		return (data.issueSearch?.nodes ?? []).flatMap((issue) => {
			const mapped = mapIssue(issue);
			return mapped ? [mapped] : [];
		});
	}

	async listTeams(apiKey: string, limit: number, signal?: AbortSignal) {
		const data = await this.graphql<{
			teams?: {
				nodes?: Array<{
					id?: string;
					key?: string;
					name?: string;
					description?: string;
				}>;
			};
		}>(
			apiKey,
			"query OhoConnectorTeams($first: Int!) { teams(first: $first) { nodes { id key name description } } }",
			{ first: limit },
			signal,
		);
		return (data.teams?.nodes ?? []).flatMap((team) =>
			team.id && team.name
				? [
						{
							id: team.id,
							key: (team.key ?? "").slice(0, 64),
							name: team.name.slice(0, 256),
							description: (team.description ?? "").slice(0, 4_096),
						},
					]
				: [],
		);
	}

	async listProjects(apiKey: string, limit: number, signal?: AbortSignal) {
		const data = await this.graphql<{
			projects?: {
				nodes?: Array<{
					id?: string;
					name?: string;
					state?: string;
					slugId?: string;
					url?: string;
					progress?: number;
					targetDate?: string;
					updatedAt?: string;
				}>;
			};
		}>(
			apiKey,
			"query OhoConnectorProjects($first: Int!) { projects(first: $first, orderBy: updatedAt) { nodes { id name state slugId url progress targetDate updatedAt } } }",
			{ first: limit },
			signal,
		);
		return (data.projects?.nodes ?? []).flatMap((project) =>
			project.id && project.name
				? [
						{
							id: project.id,
							name: project.name.slice(0, 512),
							state: (project.state ?? "").slice(0, 64),
							slugId: (project.slugId ?? "").slice(0, 128),
							url: (project.url ?? "").slice(0, 2_048),
							progress: project.progress ?? 0,
							targetDate: project.targetDate ?? "",
							updatedAt: project.updatedAt ?? "",
						},
					]
				: [],
		);
	}

	async listIssueComments(
		apiKey: string,
		issueId: string,
		limit: number,
		signal?: AbortSignal,
	) {
		const data = await this.graphql<{
			issue?: {
				comments?: {
					nodes?: Array<{
						id?: string;
						body?: string;
						url?: string;
						createdAt?: string;
						user?: { name?: string };
					}>;
				};
			};
		}>(
			apiKey,
			"query OhoConnectorIssueComments($id: String!, $first: Int!) { issue(id: $id) { comments(first: $first) { nodes { id body url createdAt user { name } } } } }",
			{ id: issueId, first: limit },
			signal,
		);
		return (data.issue?.comments?.nodes ?? []).flatMap((comment) =>
			comment.id
				? [
						{
							id: comment.id,
							body: (comment.body ?? "").slice(0, 16 * 1_024),
							url: (comment.url ?? "").slice(0, 2_048),
							createdAt: comment.createdAt ?? "",
							author: (comment.user?.name ?? "").slice(0, 256),
						},
					]
				: [],
		);
	}
}
