import {
  observeBranch,
  observePublication,
  createPublication,
} from "./github-publication.ts";
import { observePullRequest } from "./github-ci.ts";
import { parseConnectionPage } from "./github-discovery.ts";
import type {
  CodeHost,
  PullRequestRecord,
  RequiredCheck,
  PullRequestState,
  MergeRequestResult,
} from "../run/contracts.ts";
import {
  GitHubClient,
  GitHubGraphQLError,
  type GitHubCommand,
} from "./github-client.ts";

export class GitHubCodeHost implements CodeHost {
  private readonly client: GitHubClient;

  constructor(token: string, command?: GitHubCommand) {
    this.client = new GitHubClient(token, command);
  }

  observePullRequest(repository: string, branch: string, pullRequest: number) {
    return observePullRequest(this.client, repository, branch, pullRequest);
  }

  async observeDelivery(
    repository: string,
    number: number,
    issue: number,
  ): ReturnType<CodeHost["observeDelivery"]> {
    const [owner, name] = repository.split("/");
    const labels: string[] = [];
    let after: string | null = null;
    let first: Awaited<ReturnType<CodeHost["observeDelivery"]>> | undefined;
    let total: number | undefined;
    const cursors = new Set<string>();
    do {
      const response = await this.client.graphql(
        `query($owner:String!,$name:String!,$number:Int!,$issue:Int!,$after:String){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){id number url headRefName baseRefName headRefOid createdAt state mergedAt mergeable mergeStateStatus isInMergeQueue isMergeQueueEnabled autoMergeRequest{enabledAt} mergeQueueEntry{id}} issue(number:$issue){number state stateReason labels(first:100,after:$after){nodes{name} totalCount pageInfo{hasNextPage endCursor}}}}}`,
        { owner, name, number, issue, after },
      );
      if (Array.isArray(response.errors) && response.errors.length)
        throw new GitHubGraphQLError(
          "GitHub returned GraphQL errors",
          response,
        );
      const repo = (
        response.data as { repository?: Record<string, unknown> } | undefined
      )?.repository;
      const pr = repo?.pullRequest as Record<string, unknown> | undefined;
      const rawIssue = repo?.issue as Record<string, unknown> | undefined;
      if (
        !repo ||
        typeof repo.nameWithOwner !== "string" ||
        repo.nameWithOwner.toLowerCase() !== repository.toLowerCase() ||
        !pr ||
        !rawIssue ||
        pr.number !== number ||
        rawIssue.number !== issue ||
        typeof pr.id !== "string" ||
        !pr.id ||
        typeof pr.url !== "string" ||
        !pr.url ||
        typeof pr.headRefName !== "string" ||
        !pr.headRefName ||
        typeof pr.baseRefName !== "string" ||
        !pr.baseRefName ||
        !["OPEN", "CLOSED"].includes(String(rawIssue.state)) ||
        (rawIssue.state === "OPEN" &&
          rawIssue.stateReason !== null &&
          rawIssue.stateReason !== "REOPENED") ||
        (rawIssue.state === "CLOSED" &&
          rawIssue.stateReason !== "COMPLETED" &&
          rawIssue.stateReason !== "NOT_PLANNED")
      )
        throw new Error("GitHub returned invalid delivery identity");
      const state = parsePullRequestState(response, number);
      if (
        typeof pr.mergeStateStatus !== "string" ||
        !pr.mergeStateStatus ||
        typeof pr.isInMergeQueue !== "boolean" ||
        typeof pr.isMergeQueueEnabled !== "boolean"
      )
        throw new Error("GitHub returned invalid merge policy");
      state.mergeStateStatus = pr.mergeStateStatus;
      state.isInMergeQueue = pr.isInMergeQueue;
      state.isMergeQueueEnabled = pr.isMergeQueueEnabled;
      state.mergeRequested ||= pr.isInMergeQueue;
      const current = {
        pullRequest: {
          ...state,
          id: pr.id,
          number,
          url: pr.url,
          branch: pr.headRefName,
          targetBranch: pr.baseRefName,
        },
        ticket: {
          number: issue,
          state:
            rawIssue.state === "OPEN" ? ("open" as const) : ("closed" as const),
          stateReason:
            rawIssue.stateReason === "COMPLETED"
              ? ("completed" as const)
              : rawIssue.stateReason === "NOT_PLANNED"
                ? ("not_planned" as const)
                : null,
        },
      };
      if (first && JSON.stringify(first) !== JSON.stringify(current))
        throw new Error("Delivery observation changed during pagination");
      first = current;
      const raw = rawIssue.labels as Record<string, unknown>;
      const page = parseConnectionPage(raw);
      if (
        !Number.isSafeInteger(raw.totalCount) ||
        (raw.totalCount as number) < 0 ||
        (total !== undefined && total !== raw.totalCount)
      )
        throw new Error("GitHub returned invalid label count");
      total = raw.totalCount as number;
      for (const node of page.nodes) {
        const label = node as { name?: unknown };
        if (typeof label?.name !== "string" || !label.name)
          throw new Error("GitHub returned invalid label");
        labels.push(label.name);
      }
      after = page.cursor;
      if (after && cursors.has(after))
        throw new Error("GitHub returned non-advancing label pagination");
      if (after) cursors.add(after);
    } while (after);
    if (!first || labels.length !== total)
      throw new Error("GitHub returned incomplete labels");
    return { ...first, ticket: { ...first.ticket, labels } };
  }

  async getPullRequest(
    repository: string,
    pullRequest: number,
  ): Promise<PullRequestState> {
    const [owner, name] = repository.split("/");
    const response = await this.client.graphql(
      "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid createdAt state mergedAt mergeable autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}",
      { owner, name, number: pullRequest },
    );
    if (
      response.errors !== undefined &&
      (!Array.isArray(response.errors) || response.errors.length > 0)
    )
      throw new GitHubGraphQLError("GitHub returned GraphQL errors", response);
    return parsePullRequestState(response, pullRequest);
  }

  async requestSquashMerge(
    input: Parameters<CodeHost["requestSquashMerge"]>[0],
  ): Promise<MergeRequestResult> {
    try {
      const operation =
        input.queue && !input.admin
          ? "enablePullRequestAutoMerge"
          : "mergePullRequest";
      const response = await this.client.graphql(
        `mutation($input:${operation === "mergePullRequest" ? "MergePullRequestInput" : "EnablePullRequestAutoMergeInput"}!){${operation}(input:$input){pullRequest{id number headRefOid state}}}`,
        {
          input: {
            pullRequestId: input.pullRequestId,
            expectedHeadOid: input.headSha,
            mergeMethod: "SQUASH",
          },
        },
      );
      if (Array.isArray(response.errors) && response.errors.length)
        throw new GitHubGraphQLError(
          `GitHub rejected merge request: ${response.errors.map((entry: { message?: string }) => entry.message ?? "unknown error").join(", ")}`,
          response,
        );
      const data = response.data as
        | Record<
            string,
            {
              pullRequest?: {
                id?: unknown;
                number?: unknown;
                headRefOid?: unknown;
              };
            }
          >
        | undefined;
      const pr = data?.[operation]?.pullRequest;
      if (
        pr?.id !== input.pullRequestId ||
        pr.number !== input.pullRequest ||
        pr.headRefOid !== input.headSha
      )
        throw new Error("GitHub returned invalid merge request confirmation");
      return { outcome: "accepted" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        outcome: /\bmerge conflicts?\b|cannot be cleanly created/iu.test(
          message,
        )
          ? "conflict"
          : "rejected",
        error,
      };
    }
  }

  async resolveTargetBranch(repository: string): Promise<string> {
    const value = JSON.parse(
      await this.client.request([
        "api",
        "--method",
        "GET",
        `repos/${repository}`,
      ]),
    ) as { default_branch?: unknown };
    if (
      typeof value.default_branch !== "string" ||
      !value.default_branch.trim()
    )
      throw new Error("GitHub response has no Target Branch");
    return value.default_branch;
  }

  async getRemoteBranchHead(
    repository: string,
    branch: string,
  ): Promise<string | null> {
    try {
      const value = JSON.parse(
        await this.client.request([
          "api",
          `repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
        ]),
      ) as { object?: { sha?: unknown } };
      if (
        typeof value.object?.sha !== "string" ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.object.sha)
      )
        throw new Error("GitHub returned invalid remote branch head");
      return value.object.sha;
    } catch (error) {
      if (error instanceof Error && error.message.includes("HTTP 404"))
        return null;
      throw error;
    }
  }

  async listPullRequests(repository: string): Promise<PullRequestRecord[]> {
    const pages = JSON.parse(
      await this.client.request([
        "api",
        "--paginate",
        "--slurp",
        `repos/${repository}/pulls?state=all&per_page=100`,
      ]),
    ) as unknown;
    if (!Array.isArray(pages) || !pages.every(Array.isArray))
      throw new Error("GitHub returned invalid Pull Request pages");
    return (pages.flat() as unknown[])
      .map(parsePullRequest)
      .filter(
        ({ headRepository }) =>
          headRepository.toLowerCase() === repository.toLowerCase(),
      )
      .map(({ record }) => record);
  }

  observeBranch(repository: string, branch: string) {
    return observeBranch(this.client, repository, branch);
  }

  observePublication(repository: string, branch: string, targetBranch: string) {
    return observePublication(this.client, repository, branch, targetBranch);
  }

  createPullRequest(input: Parameters<CodeHost["createPullRequest"]>[0]) {
    return createPublication(this.client, input);
  }

  async getRequiredChecks(
    repository: string,
    pullRequest: number,
  ): Promise<RequiredCheck[]> {
    const value = JSON.parse(
      await this.client.request(
        [
          "pr",
          "checks",
          String(pullRequest),
          "--repo",
          repository,
          "--required",
          "--json",
          "name,state,link,bucket",
        ],
        [1, 8],
      ),
    ) as unknown;
    if (!Array.isArray(value))
      throw new Error("GitHub returned invalid required checks");
    return value.map((item: unknown) => {
      if (typeof item !== "object" || item === null || Array.isArray(item))
        throw new Error("GitHub returned invalid required check");
      const check = item as Record<string, unknown>;
      if (
        typeof check.name !== "string" ||
        typeof check.state !== "string" ||
        typeof check.link !== "string" ||
        !["pass", "fail", "pending", "skipping", "cancel"].includes(
          String(check.bucket),
        )
      )
        throw new Error("GitHub returned invalid required check");
      return {
        name: check.name,
        state: check.state,
        link: check.link,
        bucket: check.bucket as RequiredCheck["bucket"],
      };
    });
  }
}

function parsePullRequest(value: unknown): {
  headRepository: string;
  record: PullRequestRecord;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("GitHub returned invalid Pull Request");
  const row = value as {
    number?: unknown;
    node_id?: unknown;
    created_at?: unknown;
    html_url?: unknown;
    state?: unknown;
    merged_at?: unknown;
    draft?: unknown;
    head?: {
      ref?: unknown;
      sha?: unknown;
      repo?: { full_name?: unknown } | null;
    };
    base?: { ref?: unknown };
  };
  if (
    typeof row.node_id !== "string" ||
    !row.node_id.trim() ||
    typeof row.created_at !== "string" ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    !Number.isSafeInteger(row.number) ||
    (row.number as number) <= 0 ||
    typeof row.html_url !== "string" ||
    typeof row.head?.ref !== "string" ||
    typeof row.head.sha !== "string" ||
    typeof row.base?.ref !== "string" ||
    !["open", "closed"].includes(String(row.state)) ||
    typeof row.draft !== "boolean" ||
    (row.merged_at !== null && typeof row.merged_at !== "string")
  )
    throw new Error("GitHub returned invalid Pull Request");
  return {
    headRepository:
      typeof row.head.repo?.full_name === "string"
        ? row.head.repo.full_name
        : "",
    record: {
      id: row.node_id,
      createdAt: row.created_at,
      number: row.number as number,
      url: row.html_url,
      branch: row.head.ref,
      targetBranch: row.base.ref,
      headSha: row.head.sha,
      draft: row.draft,
      state:
        row.merged_at !== null ? "merged" : (row.state as "open" | "closed"),
    },
  };
}

function parsePullRequestState(
  response: { data?: unknown },
  pullRequest: number,
): PullRequestState {
  const data = response.data as
    | { repository?: { pullRequest?: Record<string, unknown> } }
    | null
    | undefined;
  const value = data?.repository?.pullRequest;
  if (
    !value ||
    typeof value.headRefOid !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.headRefOid) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !["OPEN", "CLOSED", "MERGED"].includes(String(value.state)) ||
    !["MERGEABLE", "CONFLICTING", "UNKNOWN"].includes(
      String(value.mergeable),
    ) ||
    (value.mergedAt !== null &&
      (typeof value.mergedAt !== "string" ||
        !Number.isFinite(Date.parse(value.mergedAt)))) ||
    (value.state === "MERGED") !== (value.mergedAt !== null) ||
    ![value.autoMergeRequest, value.mergeQueueEntry].every(
      (entry) =>
        entry === null || (typeof entry === "object" && !Array.isArray(entry)),
    )
  )
    throw new Error("GitHub returned invalid Pull Request state");
  const merged = value.state === "MERGED";
  return {
    headSha: value.headRefOid,
    createdAt: value.createdAt,
    merged,
    mergeRequested:
      value.autoMergeRequest !== null || value.mergeQueueEntry !== null,
    mergeable:
      value.mergeable === "MERGEABLE"
        ? "mergeable"
        : value.mergeable === "CONFLICTING"
          ? "conflicting"
          : "unknown",
    mergeFailure:
      value.state === "CLOSED" && !merged
        ? `Pull Request ${pullRequest} closed without merging`
        : null,
  };
}
