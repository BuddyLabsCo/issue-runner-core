import type {
  CodeHost,
  PublicationPullRequest,
  RequiredCheck,
  PullRequestState,
  MergeRequestResult,
} from "../run/contracts.ts";
import { observeCi } from "./github-ci.ts";
import { observeDelivery } from "./github-delivery.ts";
import { GitHubClient, type GitHubCommand } from "./github-client.ts";
import {
  observePublicationBranch,
  observePublication,
  createPublication,
} from "./github-publication.ts";

export class GitHubCodeHost implements CodeHost {
  private readonly client: GitHubClient;

  constructor(token: string, command?: GitHubCommand) {
    this.client = new GitHubClient(token, command);
  }

  observeDelivery(input: Parameters<CodeHost["observeDelivery"]>[0]) {
    return observeDelivery(this.client, input);
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
    if (response.commandError || response.errors !== undefined) {
      throw new Error("GitHub returned an incomplete Pull Request response", {
        cause: response,
      });
    }
    return parsePullRequestState(
      response as {
        data?: { repository?: { pullRequest?: Record<string, unknown> } };
      },
      pullRequest,
    );
  }

  async requestSquashMerge(
    input: Parameters<CodeHost["requestSquashMerge"]>[0],
  ): Promise<MergeRequestResult> {
    try {
      const queue = input.queue && !input.admin;
      const field = queue ? "enablePullRequestAutoMerge" : "mergePullRequest";
      const type = queue
        ? "EnablePullRequestAutoMergeInput"
        : "MergePullRequestInput";
      const response = await this.client.graphql(
        `mutation($input:${type}!){${field}(input:$input){pullRequest{id number headRefOid state}}}`,
        {
          input: {
            pullRequestId: input.pullRequestId,
            expectedHeadOid: input.headSha,
            mergeMethod: "SQUASH",
          },
        },
      );
      if (response.commandError || response.errors !== undefined)
        throw new Error(
          response.commandError?.message ??
            `GitHub rejected merge request: ${JSON.stringify(response.errors)}`,
          { cause: response },
        );
      const data = response.data as
        Record<string, { pullRequest?: Record<string, unknown> }> | undefined;
      const pr = data?.[field]?.pullRequest;
      if (
        pr?.id !== input.pullRequestId ||
        pr.number !== input.pullRequest ||
        pr.headRefOid !== input.headSha ||
        !["OPEN", "MERGED"].includes(String(pr.state))
      )
        throw new Error("GitHub returned incomplete merge response");
      return { outcome: "accepted" };
    } catch (error) {
      return { outcome: "rejected", error };
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

  async listPullRequests(
    repository: string,
  ): Promise<PublicationPullRequest[]> {
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

  observePublicationBranch(repository: string, branch: string) {
    return observePublicationBranch(this.client, repository, branch);
  }

  observePublication(input: Parameters<CodeHost["observePublication"]>[0]) {
    return observePublication(this.client, input);
  }

  observeCi(input: Parameters<CodeHost["observeCi"]>[0]) {
    return observeCi(this.client, input);
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
  record: PublicationPullRequest;
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
  response: {
    data?: { repository?: { pullRequest?: Record<string, unknown> } };
  },
  pullRequest: number,
): PullRequestState {
  const value = response?.data?.repository?.pullRequest;
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
    ![value.autoMergeRequest, value.mergeQueueEntry].every(
      (entry) =>
        entry === null || (typeof entry === "object" && !Array.isArray(entry)),
    )
  )
    throw new Error("GitHub returned invalid Pull Request state");
  const merged = value.state === "MERGED" || value.mergedAt !== null;
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
