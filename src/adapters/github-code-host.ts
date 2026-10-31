import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  CodeHost,
  PullRequestRecord,
  RequiredCheck,
  PullRequestState,
  MergeRequestResult,
} from "../run/contracts.ts";
import { GitHubClient, type GitHubCommand } from "./github-client.ts";

export class GitHubCodeHost implements CodeHost {
  private readonly client: GitHubClient;

  constructor(token: string, command?: GitHubCommand) {
    this.client = new GitHubClient(token, command);
  }

  async getPullRequest(
    repository: string,
    pullRequest: number,
  ): Promise<PullRequestState> {
    const [owner, name] = repository.split("/");
    const response = JSON.parse(
      await this.client.request([
        "api",
        "graphql",
        "-f",
        "query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid createdAt state mergedAt mergeable autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}",
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${pullRequest}`,
      ]),
    ) as { data?: { repository?: { pullRequest?: Record<string, unknown> } } };
    return parsePullRequestState(response, pullRequest);
  }

  async requestSquashMerge(
    input: Parameters<CodeHost["requestSquashMerge"]>[0],
  ): Promise<MergeRequestResult> {
    try {
      await this.client.request([
        "pr",
        "merge",
        String(input.pullRequest),
        "--repo",
        input.repository,
        "--squash",
        "--match-head-commit",
        input.headSha,
        ...(input.admin ? ["--admin"] : []),
      ]);
      return { outcome: "accepted" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        outcome: /conflict|cannot be cleanly created/iu.test(message)
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

  async createPullRequest(input: Parameters<CodeHost["createPullRequest"]>[0]) {
    const directory = await mkdtemp(path.join(tmpdir(), "issue-runner-pr-"));
    try {
      const bodyFile = path.join(directory, "body.md");
      await writeFile(bodyFile, input.body, { mode: 0o600 });
      const url = (
        await this.client.request([
          "pr",
          "create",
          "--repo",
          input.repository,
          "--base",
          input.targetBranch,
          "--head",
          input.branch,
          "--title",
          input.title,
          "--body-file",
          bodyFile,
        ])
      ).trim();
      const prefix = `https://github.com/${input.repository}/pull/`;
      const number = Number(url.slice(prefix.length));
      if (
        !url.toLowerCase().startsWith(prefix.toLowerCase()) ||
        !Number.isSafeInteger(number) ||
        number <= 0
      )
        throw new Error("GitHub returned invalid Pull Request identity");
      return { number, url };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
