import type {
  CodeHost,
  BranchObservation,
  PublicationObservation,
  PublicationQuery,
  PullRequestRecord,
  RequiredCheck,
  PullRequestState,
  MergeRequestResult,
} from "../run/contracts.ts";
import { nonempty, object } from "../agent/handoff.ts";
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
    const result = await this.client.graphql(
      "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid createdAt state mergedAt mergeable autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}",
      { owner, name, number: pullRequest },
    );
    if (result.commandError || result.response.errors?.length)
      throw new Error(
        result.commandError?.message ??
          "GitHub returned GraphQL errors for Pull Request state",
        { cause: result },
      );
    return parsePullRequestState(result.response, pullRequest);
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

  async observeBranch(repository: string, branch: string) {
    const [owner, name] = repository.split("/");
    const data = await this.publicationData(
      `query PrePush($owner: String!, $name: String!, $ref: String!) {
        repository(owner: $owner, name: $name) { ${branchFields} }
      }`,
      { owner, name, ref: `refs/heads/${branch}` },
    );
    return parseBranch(object(data.repository), repository, branch);
  }

  async observePublication({
    repository,
    branch,
    targetBranch,
  }: PublicationQuery): Promise<PublicationObservation> {
    const [owner, name] = repository.split("/");
    const pages = {
      source: publicationPages(),
      target: publicationPages(),
    };
    const candidates = new Map<string, PublicationCandidate>();
    let observation: BranchObservation | undefined;
    do {
      const data = await this.publicationData(publicationQuery, {
        owner,
        name,
        ref: `refs/heads/${branch}`,
        branch,
        base: targetBranch,
        headAfter: pages.source.after,
        baseAfter: pages.target.after,
        source: !pages.source.done,
        target: !pages.target.done,
      });
      const remote = object(data.repository);
      const current = parseBranch(remote, repository, branch);
      if (
        observation &&
        (observation.repositoryId !== current.repositoryId ||
          observation.headSha !== current.headSha)
      )
        throw new Error(
          "Remote publication branch or repository changed during pagination",
        );
      observation = current;
      for (const scope of ["source", "target"] as const) {
        const page = pages[scope];
        if (page.done) continue;
        collectPublicationPage({
          page,
          value: remote[scope],
          scope,
          expectedBranch: scope === "source" ? branch : targetBranch,
          repository,
          repositoryId: current.repositoryId,
          candidates,
        });
      }
    } while (!pages.source.done || !pages.target.done);
    return {
      ...observation,
      candidates: [...candidates.values()]
        .filter(({ sameHeadRepository }) => sameHeadRepository)
        .map(({ record }) => record),
    };
  }

  async createPullRequest(input: Parameters<CodeHost["createPullRequest"]>[0]) {
    const data = await this.publicationData(
      `mutation CreatePublication($input: CreatePullRequestInput!) {
        createPullRequest(input: $input) {
          pullRequest { ${publicationFields} }
        }
      }`,
      {
        input: {
          repositoryId: input.repositoryId,
          headRefName: input.branch,
          baseRefName: input.targetBranch,
          title: input.title,
          body: input.body,
          draft: false,
          maintainerCanModify: true,
        },
      },
    );
    const row = object(object(data.createPullRequest).pullRequest);
    const record = parsePullRequest(row, input.repository, input.repositoryId);
    if (
      !sameRepository(row.headRepository, input.repository) ||
      object(row.headRepository).id !== input.repositoryId
    )
      throw new Error(
        "GitHub returned a Pull Request from an unexpected head repository",
      );
    return record;
  }

  private async publicationData(
    query: string,
    variables: Record<string, unknown>,
  ) {
    const result = await this.client.graphql(query, variables);
    if (
      result.commandError ||
      result.response.errors?.length ||
      !result.response.data
    )
      throw new Error(
        result.commandError?.message ??
          "GitHub returned incomplete publication data",
        { cause: result },
      );
    return result.response.data;
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

const branchFields =
  "id nameWithOwner ref(qualifiedName: $ref) { name target { oid } }";
const publicationFields = `
  id number url headRefName baseRefName headRefOid state isDraft createdAt
  repository { id nameWithOwner }
  headRepository { id nameWithOwner }
`;
const publicationQuery = `
  query Publication(
    $owner: String!, $name: String!, $ref: String!,
    $branch: String!, $base: String!, $headAfter: String, $baseAfter: String,
    $source: Boolean!, $target: Boolean!
  ) {
    repository(owner: $owner, name: $name) {
      ${branchFields}
      source: pullRequests(first: 100, after: $headAfter, headRefName: $branch, states: [OPEN, CLOSED, MERGED]) @include(if: $source) {
        nodes { ...PublicationIdentity }
        pageInfo { hasNextPage endCursor }
        totalCount
      }
      target: pullRequests(first: 100, after: $baseAfter, baseRefName: $base, states: [OPEN, CLOSED, MERGED]) @include(if: $target) {
        nodes { ...PublicationIdentity }
        pageInfo { hasNextPage endCursor }
        totalCount
      }
    }
  }
  fragment PublicationIdentity on PullRequest { ${publicationFields} }
`;

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function sameRepository(value: unknown, expected: string): boolean {
  if (value === null) return false;
  const { nameWithOwner } = object(value);
  if (!nonempty(nameWithOwner))
    throw new Error("GitHub returned a repository without a name");
  return nameWithOwner.toLowerCase() === expected.toLowerCase();
}

function parseBranch(
  remote: Record<string, unknown>,
  repository: string,
  branch: string,
): BranchObservation {
  if (!sameRepository(remote, repository) || !nonempty(remote.id))
    throw new Error("GitHub returned an unexpected publication repository");
  if (remote.ref === null) return { repositoryId: remote.id, headSha: null };
  const ref = object(remote.ref);
  const { oid: headSha } = object(ref.target);
  if (ref.name !== branch || typeof headSha !== "string" || !oid.test(headSha))
    throw new Error("GitHub returned invalid remote branch head");
  return { repositoryId: remote.id, headSha };
}

function publicationPages() {
  return {
    after: null as string | null,
    total: undefined as number | undefined,
    done: false,
    ids: new Set<string>(),
    cursors: new Set<string>(),
  };
}

interface PublicationCandidate {
  record: PullRequestRecord;
  sameHeadRepository: boolean;
}

function collectPublicationPage(input: {
  page: ReturnType<typeof publicationPages>;
  value: unknown;
  scope: "source" | "target";
  expectedBranch: string;
  repository: string;
  repositoryId: string;
  candidates: Map<string, PublicationCandidate>;
}) {
  const {
    page,
    value,
    scope,
    expectedBranch,
    repository,
    repositoryId,
    candidates,
  } = input;
  for (const node of readPublicationPage(page, value)) {
    const row = object(node);
    const record = parsePullRequest(row, repository, repositoryId);
    const actualBranch =
      scope === "source" ? record.branch : record.targetBranch;
    if (page.ids.has(record.id) || actualBranch !== expectedBranch)
      throw new Error("GitHub returned inconsistent Pull Request pages");
    page.ids.add(record.id);
    const headRepository = sameRepository(row.headRepository, repository);
    if (headRepository && object(row.headRepository).id !== repositoryId)
      throw new Error("GitHub returned an unexpected head repository ID");
    const candidate = { record, sameHeadRepository: headRepository };
    const previous = candidates.get(record.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(candidate))
      throw new Error("GitHub returned conflicting Pull Request observations");
    candidates.set(record.id, candidate);
  }
}

function readPublicationPage(
  page: ReturnType<typeof publicationPages>,
  value: unknown,
) {
  const { nodes, totalCount, pageInfo } = object(value);
  const { hasNextPage, endCursor } = object(pageInfo);
  if (
    !Array.isArray(nodes) ||
    nodes.length > 100 ||
    typeof totalCount !== "number" ||
    !Number.isSafeInteger(totalCount) ||
    totalCount < 0 ||
    (page.total !== undefined && page.total !== totalCount) ||
    typeof hasNextPage !== "boolean" ||
    (endCursor !== null && !nonempty(endCursor))
  )
    throw new Error("GitHub returned invalid Pull Request pages");
  const received = page.ids.size + nodes.length;
  if (hasNextPage ? received >= totalCount : received !== totalCount)
    throw new Error("GitHub returned incomplete Pull Request pages");
  page.total = totalCount;
  page.done = !hasNextPage;
  if (hasNextPage) {
    if (!nodes.length || !nonempty(endCursor) || page.cursors.has(endCursor))
      throw new Error("GitHub returned an incomplete Pull Request cursor");
    page.cursors.add(endCursor);
    page.after = endCursor;
  }
  return nodes as unknown[];
}

function parsePullRequest(
  row: Record<string, unknown>,
  repository: string,
  repositoryId: string,
): PullRequestRecord {
  const {
    id,
    number,
    url,
    headRefName,
    baseRefName,
    headRefOid,
    state,
    isDraft,
    createdAt,
  } = row;
  if (
    !sameRepository(row.repository, repository) ||
    object(row.repository).id !== repositoryId ||
    !nonempty(id) ||
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    typeof url !== "string" ||
    url.toLowerCase() !==
      `https://github.com/${repository}/pull/${number}`.toLowerCase() ||
    !nonempty(headRefName) ||
    !nonempty(baseRefName) ||
    typeof headRefOid !== "string" ||
    !oid.test(headRefOid) ||
    (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") ||
    typeof isDraft !== "boolean" ||
    typeof createdAt !== "string" ||
    !Number.isFinite(Date.parse(createdAt))
  )
    throw new Error("GitHub returned invalid Pull Request identity");
  return {
    id,
    number,
    url,
    createdAt,
    branch: headRefName,
    targetBranch: baseRefName,
    headSha: headRefOid,
    draft: isDraft,
    state: state === "OPEN" ? "open" : state === "CLOSED" ? "closed" : "merged",
  };
}

function parsePullRequestState(
  response: {
    data?: { repository?: { pullRequest?: Record<string, unknown> } } | null;
  },
  pullRequest: number,
): PullRequestState {
  const value = response?.data?.repository?.pullRequest;
  if (
    !value ||
    typeof value.headRefOid !== "string" ||
    !oid.test(value.headRefOid) ||
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
