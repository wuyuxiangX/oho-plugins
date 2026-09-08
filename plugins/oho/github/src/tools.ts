import type { ToolManifest } from "../../../../runtime/contracts.js";
import { z } from "zod";
import type { ProviderService } from "../../../../runtime/service.js";
import { ConnectorServiceError } from "../../../../runtime/errors.js";
import {
	connectorManifest,
	executeConnectorRead,
	privateConnectorAudit,
	requireConnectorConnection,
} from "../../../../runtime/read-support.js";
import type {
	RegisteredTool,
	ToolImplementationContext,
} from "../../../../runtime/tool.js";

const ownerSchema = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9_.-]+$/);
const repositoryNameSchema = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9_.-]+$/);
const refSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[^\u0000-\u001f\u007f]+$/);
const repositoryPathSchema = z
	.string()
	.max(1_024)
	.refine(
		(value) =>
			!value.startsWith("/") &&
			!value.split("/").some((part) => part === "." || part === ".."),
		"path must be repository-relative",
	);
const filePathSchema = repositoryPathSchema.refine(
	(value) => value.length > 0,
	"file path is required",
);
const limitSchema = z.number().int().min(1).max(30).default(20);
const detailLimitSchema = z.number().int().min(1).max(10).default(10);
const pageSchema = z.number().int().min(1).max(10).default(1);
const stateSchema = z.enum(["open", "closed", "all"]).default("open");

const repositoryInputFields = {
	owner: ownerSchema,
	repository: repositoryNameSchema,
};
const repositoryJsonProperties = {
	owner: { type: "string", minLength: 1, maxLength: 100 },
	repository: { type: "string", minLength: 1, maxLength: 100 },
} as const;
const paginationJsonProperties = {
	limit: { type: "integer", minimum: 1, maximum: 30, default: 20 },
	page: { type: "integer", minimum: 1, maximum: 10, default: 1 },
} as const;
const detailPaginationJsonProperties = {
	limit: { type: "integer", minimum: 1, maximum: 10, default: 10 },
	page: { type: "integer", minimum: 1, maximum: 10, default: 1 },
} as const;

const repositorySchema = z
	.object({
		id: z.string(),
		name: z.string().max(256),
		fullName: z.string().max(512),
		description: z.string().max(4_096),
		url: z.string().url().max(2_048),
		updatedAt: z.string(),
		language: z.string().max(128).optional(),
		defaultBranch: z.string().max(256).optional(),
		stars: z.number().int().nonnegative().optional(),
		forks: z.number().int().nonnegative().optional(),
		openIssues: z.number().int().nonnegative().optional(),
	})
	.strict();

const pageOutputFields = {
	page: z.number().int().positive(),
	hasMore: z.boolean(),
};

const issueSummarySchema = z
	.object({
		id: z.string(),
		number: z.number().int().positive(),
		title: z.string().max(512),
		url: z.string().url().max(2_048),
		state: z.enum(["open", "closed"]),
		author: z.string().max(256).optional(),
		labels: z.array(z.string().max(256)).max(20),
		createdAt: z.string(),
		updatedAt: z.string(),
		closedAt: z.string().optional(),
		stateReason: z.string().max(128).optional(),
	})
	.strict();

const pullRequestSummarySchema = z
	.object({
		id: z.string(),
		number: z.number().int().positive(),
		title: z.string().max(512),
		url: z.string().url().max(2_048),
		state: z.enum(["open", "closed"]),
		draft: z.boolean(),
		author: z.string().max(256).optional(),
		baseRef: z.string().max(256),
		headRef: z.string().max(256),
		createdAt: z.string(),
		updatedAt: z.string(),
		closedAt: z.string().optional(),
		mergedAt: z.string().optional(),
	})
	.strict();

const changedFileSchema = z
	.object({
		sha: z.string().max(64),
		path: z.string().max(1_024),
		status: z.string().max(64),
		additions: z.number().int().nonnegative(),
		deletions: z.number().int().nonnegative(),
		changes: z.number().int().nonnegative(),
		patch: z.string().max(8_192).optional(),
	})
	.strict();

const commitSummarySchema = z
	.object({
		sha: z.string().max(64),
		message: z.string().max(4_096),
		url: z.string().url().max(2_048),
		author: z.string().max(256).optional(),
		authoredAt: z.string().optional(),
	})
	.strict();

function manifest(input: {
	id: string;
	runtimeName: string;
	label: string;
	description: string;
	inputSchema: ToolManifest["inputSchema"];
	risk?: "low" | "medium";
	maxCallsPerRun?: number;
}): ToolManifest {
	return connectorManifest({
		id: input.id,
		runtimeName: input.runtimeName,
		version: "1.0.0",
		label: input.label,
		description: input.description,
		inputSchema: input.inputSchema,
		outputSchema: { type: "object" },
		risk: input.risk ?? "low",
		sideEffect: "none",
		network: "restricted",
		timeoutMs: 20_000,
		maxCallsPerRun: input.maxCallsPerRun ?? 6,
		executionMode: "sequential",
	});
}

function githubReadTool<TInput, TOutput>(input: {
	manifest: ToolManifest;
	inputValidator: z.ZodType<TInput>;
	outputValidator: z.ZodType<TOutput>;
	execute: (
		input: TInput,
		connectionId: string,
		context: ToolImplementationContext,
	) => Promise<TOutput>;
	audit: (output: TOutput) => Record<string, unknown>;
}): RegisteredTool<TInput, TOutput> {
	return {
		manifest: input.manifest,
		inputValidator: input.inputValidator,
		outputValidator: input.outputValidator,
		async execute(value, context) {
			const connectionId = requireConnectorConnection(
				context,
				input.manifest.id,
			);
			return executeConnectorRead("GitHub", () =>
				input.execute(value, connectionId, context),
			);
		},
		toModelContent: (output) => JSON.stringify(output),
		toPersistedOutput: (output) =>
			privateConnectorAudit(input.manifest.id, input.audit(output)),
	};
}

const repositoriesListInput = z
	.object({ limit: limitSchema, page: pageSchema })
	.strict();
const repositoriesOutput = z
	.object({
		repositories: z.array(repositorySchema).max(30),
		...pageOutputFields,
	})
	.strict();
const repositoriesSearchInput = z
	.object({
		query: z.string().trim().min(1).max(256),
		limit: limitSchema,
		page: pageSchema,
	})
	.strict();
const repositoryReadInput = z.object(repositoryInputFields).strict();
const repositoryOutput = z.object({ repository: repositorySchema }).strict();
const contentsListInput = z
	.object({
		...repositoryInputFields,
		path: repositoryPathSchema.default(""),
		ref: refSchema.optional(),
		limit: z.number().int().min(1).max(50).default(30),
	})
	.strict();
const contentEntrySchema = z
	.object({
		name: z.string().max(256),
		path: z.string().max(1_024),
		type: z.enum(["file", "dir", "symlink", "submodule"]),
		sha: z.string().max(64),
		size: z.number().int().nonnegative(),
		url: z.string().url().max(2_048),
	})
	.strict();
const contentsOutput = z
	.object({
		entries: z.array(contentEntrySchema).max(50),
		truncated: z.boolean(),
	})
	.strict();
const fileReadInput = z
	.object({
		...repositoryInputFields,
		path: filePathSchema,
		ref: refSchema.optional(),
	})
	.strict();
const fileOutput = z
	.object({
		file: z
			.object({
				path: z.string().max(1_024),
				sha: z.string().max(64),
				size: z.number().int().nonnegative().max(65_536),
				content: z.string().max(65_536),
				url: z.string().url().max(2_048),
			})
			.strict(),
	})
	.strict();
const resourceListInput = z
	.object({
		...repositoryInputFields,
		state: stateSchema,
		limit: limitSchema,
		page: pageSchema,
	})
	.strict();
const numberedResourceInput = z
	.object({
		...repositoryInputFields,
		number: z.number().int().positive().max(2_147_483_647),
	})
	.strict();
const numberedResourcePageInput = numberedResourceInput
	.extend({ limit: detailLimitSchema, page: pageSchema })
	.strict();
const issuesOutput = z
	.object({
		issues: z.array(issueSummarySchema).max(30),
		...pageOutputFields,
	})
	.strict();
const issueOutput = z
	.object({
		issue: issueSummarySchema.extend({ body: z.string().max(32_768) }).strict(),
	})
	.strict();
const commentsOutput = z
	.object({
		comments: z
			.array(
				z
					.object({
						id: z.string(),
						author: z.string().max(256).optional(),
						body: z.string().max(8_192),
						url: z.string().url().max(2_048),
						createdAt: z.string(),
						updatedAt: z.string(),
					})
					.strict(),
			)
			.max(10),
		...pageOutputFields,
	})
	.strict();
const pullRequestsOutput = z
	.object({
		pullRequests: z.array(pullRequestSummarySchema).max(30),
		...pageOutputFields,
	})
	.strict();
const pullRequestOutput = z
	.object({
		pullRequest: pullRequestSummarySchema
			.extend({ body: z.string().max(32_768) })
			.strict(),
	})
	.strict();
const changedFilesOutput = z
	.object({
		files: z.array(changedFileSchema).max(10),
		...pageOutputFields,
	})
	.strict();
const commitsListInput = z
	.object({
		...repositoryInputFields,
		ref: refSchema.optional(),
		limit: limitSchema,
		page: pageSchema,
	})
	.strict();
const commitsOutput = z
	.object({
		commits: z.array(commitSummarySchema).max(30),
		...pageOutputFields,
	})
	.strict();
const commitReadInput = z
	.object({ ...repositoryInputFields, ref: refSchema })
	.strict();
const commitOutput = z
	.object({
		commit: commitSummarySchema
			.extend({
				stats: z
					.object({
						additions: z.number().int().nonnegative(),
						deletions: z.number().int().nonnegative(),
						total: z.number().int().nonnegative(),
					})
					.strict()
					.optional(),
				files: z.array(changedFileSchema).max(20),
				filesTruncated: z.boolean(),
			})
			.strict(),
	})
	.strict();
const plainRepositoryPageInput = z
	.object({ ...repositoryInputFields, limit: limitSchema, page: pageSchema })
	.strict();
const branchesOutput = z
	.object({
		branches: z
			.array(
				z
					.object({
						name: z.string().max(256),
						sha: z.string().max(64),
						protected: z.boolean(),
					})
					.strict(),
			)
			.max(30),
		...pageOutputFields,
	})
	.strict();
const releasesOutput = z
	.object({
		releases: z
			.array(
				z
					.object({
						id: z.string(),
						name: z.string().max(512),
						tagName: z.string().max(256),
						url: z.string().url().max(2_048),
						draft: z.boolean(),
						prerelease: z.boolean(),
						createdAt: z.string(),
						publishedAt: z.string().optional(),
					})
					.strict(),
			)
			.max(30),
		...pageOutputFields,
	})
	.strict();

export const GITHUB_MANIFESTS = [
	manifest({
		id: "github.repositories.list",
		runtimeName: "github_list_public_repositories",
		label: "查看 GitHub 公开仓库",
		description:
			"List public repositories associated with the connected GitHub user. Private repositories are not requested.",
		inputSchema: {
			type: "object",
			properties: paginationJsonProperties,
			additionalProperties: false,
		},
	}),
	manifest({
		id: "github.repositories.search",
		runtimeName: "github_search_public_repositories",
		label: "搜索 GitHub 公开仓库",
		description: "Search public GitHub repositories by keywords.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", minLength: 1, maxLength: 256 },
				...paginationJsonProperties,
			},
			required: ["query"],
			additionalProperties: false,
		},
	}),
	manifest({
		id: "github.repository.read",
		runtimeName: "github_read_public_repository",
		label: "读取 GitHub 仓库信息",
		description: "Read metadata for one public GitHub repository.",
		inputSchema: {
			type: "object",
			properties: repositoryJsonProperties,
			required: ["owner", "repository"],
			additionalProperties: false,
		},
	}),
	manifest({
		id: "github.repository.contents.list",
		runtimeName: "github_list_public_repository_contents",
		label: "查看 GitHub 仓库目录",
		description: "List a bounded directory in a public GitHub repository.",
		inputSchema: {
			type: "object",
			properties: {
				...repositoryJsonProperties,
				path: { type: "string", maxLength: 1_024, default: "" },
				ref: { type: "string", minLength: 1, maxLength: 256 },
				limit: { type: "integer", minimum: 1, maximum: 50, default: 30 },
			},
			required: ["owner", "repository"],
			additionalProperties: false,
		},
	}),
	manifest({
		id: "github.repository.file.read",
		runtimeName: "github_read_public_repository_file",
		label: "读取 GitHub 仓库文件",
		description:
			"Read one explicitly selected UTF-8 text file up to 64 KiB from a public repository.",
		risk: "medium",
		inputSchema: {
			type: "object",
			properties: {
				...repositoryJsonProperties,
				path: { type: "string", minLength: 1, maxLength: 1_024 },
				ref: { type: "string", minLength: 1, maxLength: 256 },
			},
			required: ["owner", "repository", "path"],
			additionalProperties: false,
		},
	}),
	manifest({
		id: "github.issues.list",
		runtimeName: "github_list_issues",
		label: "查看 GitHub Issues",
		description: "List issues in one public GitHub repository.",
		inputSchema: {
			type: "object",
			properties: {
				...repositoryJsonProperties,
				state: {
					type: "string",
					enum: ["open", "closed", "all"],
					default: "open",
				},
				...paginationJsonProperties,
			},
			required: ["owner", "repository"],
			additionalProperties: false,
		},
	}),
	manifest({
		id: "github.issue.read",
		runtimeName: "github_read_issue",
		label: "读取 GitHub Issue",
		description: "Read one issue and its body from a public GitHub repository.",
		risk: "medium",
		inputSchema: {
			type: "object",
			properties: {
				...repositoryJsonProperties,
				number: { type: "integer", minimum: 1 },
			},
			required: ["owner", "repository", "number"],
			additionalProperties: false,
		},
	}),
	manifest({
		id: "github.issue.comments.list",
		runtimeName: "github_list_issue_comments",
		label: "查看 GitHub Issue 评论",
		description: "List bounded comments for one public issue or pull request.",
		risk: "medium",
		inputSchema: {
			type: "object",
			properties: {
				...repositoryJsonProperties,
				number: { type: "integer", minimum: 1 },
				...detailPaginationJsonProperties,
			},
			required: ["owner", "repository", "number"],
			additionalProperties: false,
		},
	}),
	manifest({
		id: "github.pull_requests.list",
		runtimeName: "github_list_pull_requests",
		label: "查看 GitHub Pull Requests",
		description: "List pull requests in one public GitHub repository.",
		inputSchema: {
			type: "object",
			properties: {
				...repositoryJsonProperties,
				state: {
					type: "string",
					enum: ["open", "closed", "all"],
					default: "open",
				},
				...paginationJsonProperties,
			},
			required: ["owner", "repository"],
			additionalProperties: false,
		},
	}),
	manifest({
		id: "github.pull_request.read",
		runtimeName: "github_read_pull_request",
		label: "读取 GitHub Pull Request",
		description:
			"Read one pull request and its body from a public GitHub repository.",
		risk: "medium",
		inputSchema: {
			type: "object",
			properties: {
				...repositoryJsonProperties,
				number: { type: "integer", minimum: 1 },
			},
			required: ["owner", "repository", "number"],
			additionalProperties: false,
		},
	}),
	manifest({
		id: "github.pull_request.files.list",
		runtimeName: "github_list_pull_request_files",
		label: "查看 GitHub PR 文件变更",
		description:
			"List bounded file changes and patch excerpts for one public pull request.",
		risk: "medium",
		inputSchema: {
			type: "object",
			properties: {
				...repositoryJsonProperties,
				number: { type: "integer", minimum: 1 },
				...detailPaginationJsonProperties,
			},
			required: ["owner", "repository", "number"],
			additionalProperties: false,
		},
	}),
	manifest({
		id: "github.commits.list",
		runtimeName: "github_list_commits",
		label: "查看 GitHub 提交",
		description:
			"List commits for a public repository and optional branch, tag, or SHA.",
		inputSchema: {
			type: "object",
			properties: {
				...repositoryJsonProperties,
				ref: { type: "string", minLength: 1, maxLength: 256 },
				...paginationJsonProperties,
			},
			required: ["owner", "repository"],
			additionalProperties: false,
		},
	}),
	manifest({
		id: "github.commit.read",
		runtimeName: "github_read_commit",
		label: "读取 GitHub 提交详情",
		description:
			"Read one commit and bounded changed-file details from a public repository.",
		risk: "medium",
		inputSchema: {
			type: "object",
			properties: {
				...repositoryJsonProperties,
				ref: { type: "string", minLength: 1, maxLength: 256 },
			},
			required: ["owner", "repository", "ref"],
			additionalProperties: false,
		},
	}),
	manifest({
		id: "github.branches.list",
		runtimeName: "github_list_branches",
		label: "查看 GitHub 分支",
		description: "List branches in one public GitHub repository.",
		inputSchema: {
			type: "object",
			properties: { ...repositoryJsonProperties, ...paginationJsonProperties },
			required: ["owner", "repository"],
			additionalProperties: false,
		},
	}),
	manifest({
		id: "github.releases.list",
		runtimeName: "github_list_releases",
		label: "查看 GitHub Releases",
		description: "List releases in one public GitHub repository.",
		inputSchema: {
			type: "object",
			properties: { ...repositoryJsonProperties, ...paginationJsonProperties },
			required: ["owner", "repository"],
			additionalProperties: false,
		},
	}),
] as const;

export const GITHUB_TOOL_REFS: Readonly<Record<string, string>> = Object.freeze(
	Object.fromEntries(
		GITHUB_MANIFESTS.map((item) => [item.id, `${item.id}@${item.version}`]),
	),
);

export function createGitHubTools(
	connectors: ProviderService,
): RegisteredTool[] {
	const [
		repositoriesListManifest,
		repositoriesSearchManifest,
		repositoryReadManifest,
		contentsListManifest,
		fileReadManifest,
		issuesListManifest,
		issueReadManifest,
		commentsListManifest,
		pullRequestsListManifest,
		pullRequestReadManifest,
		pullRequestFilesManifest,
		commitsListManifest,
		commitReadManifest,
		branchesListManifest,
		releasesListManifest,
	] = GITHUB_MANIFESTS;

	return [
		githubReadTool({
			manifest: repositoriesListManifest,
			inputValidator: repositoriesListInput,
			outputValidator: repositoriesOutput,
			execute: async (input, connectionId, context) => {
				const page = await connectors.listGitHubRepositories(
					context.userId,
					connectionId,
					input,
					context.signal,
				);
				return {
					repositories: page.items,
					page: page.page,
					hasMore: page.hasMore,
				};
			},
			audit: (output) => ({
				count: output.repositories.length,
				repositoryIds: output.repositories.map((item) => item.id),
				page: output.page,
				hasMore: output.hasMore,
			}),
		}),
		githubReadTool({
			manifest: repositoriesSearchManifest,
			inputValidator: repositoriesSearchInput,
			outputValidator: repositoriesOutput,
			execute: async (input, connectionId, context) => {
				const page = await connectors.searchGitHubRepositories(
					context.userId,
					connectionId,
					input,
					context.signal,
				);
				return {
					repositories: page.items,
					page: page.page,
					hasMore: page.hasMore,
				};
			},
			audit: (output) => ({
				count: output.repositories.length,
				repositoryIds: output.repositories.map((item) => item.id),
				page: output.page,
				hasMore: output.hasMore,
			}),
		}),
		githubReadTool({
			manifest: repositoryReadManifest,
			inputValidator: repositoryReadInput,
			outputValidator: repositoryOutput,
			execute: async (input, connectionId, context) => ({
				repository: await connectors.readGitHubRepository(
					context.userId,
					connectionId,
					input.owner,
					input.repository,
					context.signal,
				),
			}),
			audit: (output) => ({ repositoryId: output.repository.id }),
		}),
		githubReadTool({
			manifest: contentsListManifest,
			inputValidator: contentsListInput,
			outputValidator: contentsOutput,
			execute: (input, connectionId, context) =>
				connectors.listGitHubRepositoryContents(
					context.userId,
					connectionId,
					input,
					context.signal,
				),
			audit: (output) => ({
				count: output.entries.length,
				paths: output.entries.map((entry) => entry.path),
				truncated: output.truncated,
			}),
		}),
		githubReadTool({
			manifest: fileReadManifest,
			inputValidator: fileReadInput,
			outputValidator: fileOutput,
			execute: async (input, connectionId, context) => ({
				file: await connectors.readGitHubRepositoryFile(
					context.userId,
					connectionId,
					input,
					context.signal,
				),
			}),
			audit: (output) => ({
				path: output.file.path,
				sha: output.file.sha,
				bytes: output.file.size,
			}),
		}),
		githubReadTool({
			manifest: issuesListManifest,
			inputValidator: resourceListInput,
			outputValidator: issuesOutput,
			execute: async (input, connectionId, context) => {
				const page = await connectors.listGitHubIssues(
					context.userId,
					connectionId,
					input,
					context.signal,
				);
				return { issues: page.items, page: page.page, hasMore: page.hasMore };
			},
			audit: (output) => ({
				count: output.issues.length,
				numbers: output.issues.map((issue) => issue.number),
				page: output.page,
				hasMore: output.hasMore,
			}),
		}),
		githubReadTool({
			manifest: issueReadManifest,
			inputValidator: numberedResourceInput,
			outputValidator: issueOutput,
			execute: async (input, connectionId, context) => ({
				issue: await connectors.readGitHubIssue(
					context.userId,
					connectionId,
					input,
					context.signal,
				),
			}),
			audit: (output) => ({
				issueId: output.issue.id,
				number: output.issue.number,
				bodyBytes: Buffer.byteLength(output.issue.body, "utf8"),
			}),
		}),
		githubReadTool({
			manifest: commentsListManifest,
			inputValidator: numberedResourcePageInput,
			outputValidator: commentsOutput,
			execute: async (input, connectionId, context) => {
				const page = await connectors.listGitHubIssueComments(
					context.userId,
					connectionId,
					input,
					context.signal,
				);
				return { comments: page.items, page: page.page, hasMore: page.hasMore };
			},
			audit: (output) => ({
				count: output.comments.length,
				commentIds: output.comments.map((comment) => comment.id),
				page: output.page,
				hasMore: output.hasMore,
			}),
		}),
		githubReadTool({
			manifest: pullRequestsListManifest,
			inputValidator: resourceListInput,
			outputValidator: pullRequestsOutput,
			execute: async (input, connectionId, context) => {
				const page = await connectors.listGitHubPullRequests(
					context.userId,
					connectionId,
					input,
					context.signal,
				);
				return {
					pullRequests: page.items,
					page: page.page,
					hasMore: page.hasMore,
				};
			},
			audit: (output) => ({
				count: output.pullRequests.length,
				numbers: output.pullRequests.map((item) => item.number),
				page: output.page,
				hasMore: output.hasMore,
			}),
		}),
		githubReadTool({
			manifest: pullRequestReadManifest,
			inputValidator: numberedResourceInput,
			outputValidator: pullRequestOutput,
			execute: async (input, connectionId, context) => ({
				pullRequest: await connectors.readGitHubPullRequest(
					context.userId,
					connectionId,
					input,
					context.signal,
				),
			}),
			audit: (output) => ({
				pullRequestId: output.pullRequest.id,
				number: output.pullRequest.number,
				bodyBytes: Buffer.byteLength(output.pullRequest.body, "utf8"),
			}),
		}),
		githubReadTool({
			manifest: pullRequestFilesManifest,
			inputValidator: numberedResourcePageInput,
			outputValidator: changedFilesOutput,
			execute: async (input, connectionId, context) => {
				const page = await connectors.listGitHubPullRequestFiles(
					context.userId,
					connectionId,
					input,
					context.signal,
				);
				return { files: page.items, page: page.page, hasMore: page.hasMore };
			},
			audit: (output) => ({
				count: output.files.length,
				paths: output.files.map((file) => file.path),
				page: output.page,
				hasMore: output.hasMore,
			}),
		}),
		githubReadTool({
			manifest: commitsListManifest,
			inputValidator: commitsListInput,
			outputValidator: commitsOutput,
			execute: async (input, connectionId, context) => {
				const page = await connectors.listGitHubCommits(
					context.userId,
					connectionId,
					input,
					context.signal,
				);
				return { commits: page.items, page: page.page, hasMore: page.hasMore };
			},
			audit: (output) => ({
				count: output.commits.length,
				shas: output.commits.map((commit) => commit.sha),
				page: output.page,
				hasMore: output.hasMore,
			}),
		}),
		githubReadTool({
			manifest: commitReadManifest,
			inputValidator: commitReadInput,
			outputValidator: commitOutput,
			execute: async (input, connectionId, context) => ({
				commit: await connectors.readGitHubCommit(
					context.userId,
					connectionId,
					input,
					context.signal,
				),
			}),
			audit: (output) => ({
				sha: output.commit.sha,
				changedFileCount: output.commit.files.length,
				filesTruncated: output.commit.filesTruncated,
			}),
		}),
		githubReadTool({
			manifest: branchesListManifest,
			inputValidator: plainRepositoryPageInput,
			outputValidator: branchesOutput,
			execute: async (input, connectionId, context) => {
				const page = await connectors.listGitHubBranches(
					context.userId,
					connectionId,
					input,
					context.signal,
				);
				return { branches: page.items, page: page.page, hasMore: page.hasMore };
			},
			audit: (output) => ({
				count: output.branches.length,
				branchNames: output.branches.map((branch) => branch.name),
				page: output.page,
				hasMore: output.hasMore,
			}),
		}),
		githubReadTool({
			manifest: releasesListManifest,
			inputValidator: plainRepositoryPageInput,
			outputValidator: releasesOutput,
			execute: async (input, connectionId, context) => {
				const page = await connectors.listGitHubReleases(
					context.userId,
					connectionId,
					input,
					context.signal,
				);
				return { releases: page.items, page: page.page, hasMore: page.hasMore };
			},
			audit: (output) => ({
				count: output.releases.length,
				releaseIds: output.releases.map((release) => release.id),
				page: output.page,
				hasMore: output.hasMore,
			}),
		}),
	];
}
