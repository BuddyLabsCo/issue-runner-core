import type {
  CodeHost,
  BranchObservation,
  PublicationObservation,
  PublicationQuery,
  PullRequestRecord,
  PullRequestQuery,
  PullRequestObservation,
  PullRequestState,
  MergeRequestResult,
} from "../run/contracts.ts";
import { nonempty, object } from "../agent/handoff.ts";
import { GitHubClient, type GitHubCommand } from "./github-client.ts";
import {
  branchFields,
  oid,
  publicationFields,
  parseCheckContext,
  parseMergeFacts,
  parsePullRequestState,
  pollQuery,
  requiredChecks,
} from "./github-pr-checks.ts";

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
    return parsePullRequestState(
      object(result.response.data?.repository).pullRequest,
      pullRequest,
    );
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
    const data = await this.graphqlData(
      `query PrePush($owner: String!, $name: String!, $ref: String!) {
        repository(owner: $owner, name: $name) { ${branchFields} }
      }`,
      { owner, name, ref: `refs/heads/${branch}` },
    );
    return parseBranch(object(data.repository), repository, branch);
  }

  async observePublication(
    { repository, branch, targetBranch }: PublicationQuery,
    signal?: AbortSignal,
  ): Promise<PublicationObservation> {
    const [owner, name] = repository.split("/");
    const pages = {
      source: publicationPages(),
      target: publicationPages(),
    };
    const candidates = new Map<string, PublicationCandidate>();
    let observation: BranchObservation | undefined;
    do {
      signal?.throwIfAborted();
      const data = await this.graphqlData(publicationQuery, {
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
      signal?.throwIfAborted();
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
    const data = await this.graphqlData(
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

  private async graphqlData(query: string, variables: Record<string, unknown>) {
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

  async observePullRequest(
    { repository, branch, number }: PullRequestQuery,
    signal?: AbortSignal,
  ): Promise<PullRequestObservation> {
    const [owner, name] = repository.split("/");
    let page = connectionPages();
    let contexts: ReturnType<typeof parseCheckContext>[] = [];
    let previous: string | undefined;
    let restarted = false;
    for (;;) {
      signal?.throwIfAborted();
      const data = await this.graphqlData(pollQuery, {
        owner,
        name,
        number,
        ref: `refs/heads/${branch}`,
        after: page.after,
      });
      signal?.throwIfAborted();
      const remote = object(data.repository);
      const observedBranch = parseBranch(remote, repository, branch);
      const row = object(remote.pullRequest);
      const pullRequest = parsePullRequest(
        row,
        repository,
        observedBranch.repositoryId,
      );
      if (
        pullRequest.number !== number ||
        !sameRepository(row.headRepository, repository) ||
        object(row.headRepository).id !== observedBranch.repositoryId
      )
        throw new Error(
          "GitHub returned an unexpected Pull Request or head repository",
        );
      const { nodes } = object(row.commits);
      if (!Array.isArray(nodes) || nodes.length !== 1)
        throw new Error("GitHub did not return the last Pull Request commit");
      const { oid: lastCommitSha, statusCheckRollup } = object(
        object(nodes[0]).commit,
      );
      if (typeof lastCommitSha !== "string" || !oid.test(lastCommitSha))
        throw new Error("GitHub returned an invalid last Pull Request commit");

      const evidence = JSON.stringify([
        observedBranch,
        pullRequest,
        lastCommitSha,
      ]);
      if (previous !== undefined && previous !== evidence) {
        if (restarted)
          throw new Error(
            "Pull Request evidence changed again during check pagination",
          );
        restarted = true;
        previous = undefined;
        page = connectionPages();
        contexts = [];
        continue;
      }
      previous = evidence;
      const merge = parseMergeFacts(row, number);
      if (statusCheckRollup === null) {
        if (page.after !== null)
          throw new Error("Check rollup disappeared during pagination");
      } else {
        for (const node of readConnectionPage(
          page,
          object(statusCheckRollup).contexts,
          contexts.length,
          "check context",
        ))
          contexts.push(parseCheckContext(node));
        if (!page.done) continue;
      }
      return {
        branch: observedBranch,
        pullRequest,
        lastCommitSha,
        merge,
        checks: requiredChecks(contexts),
      };
    }
  }
}

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

function connectionPages() {
  return {
    after: null as string | null,
    total: undefined as number | undefined,
    done: false,
    cursors: new Set<string>(),
  };
}

function publicationPages() {
  return { ...connectionPages(), ids: new Set<string>() };
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
  for (const node of readConnectionPage(
    page,
    value,
    page.ids.size,
    "Pull Request",
  )) {
    const row = object(node);
    const record = parsePullRequest(row, repository, repositoryId);
    const actualBranch =
      scope === "source" ? record.branch : record.targetBranch;
    if (page.ids.has(record.id) || actualBranch !== expectedBranch)
      throw new Error("GitHub returned inconsistent Pull Request pages");
    page.ids.add(record.id);
    const { headRepository } = row;
    const sameHeadRepository = sameRepository(headRepository, repository);
    if (headRepository !== null) {
      const { id } = object(headRepository);
      if (!nonempty(id) || sameHeadRepository !== (id === repositoryId))
        throw new Error("GitHub returned an unexpected head repository ID");
    }
    const candidate = { record, sameHeadRepository };
    const previous = candidates.get(record.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(candidate))
      throw new Error("GitHub returned conflicting Pull Request observations");
    candidates.set(record.id, candidate);
  }
}

function readConnectionPage(
  page: ReturnType<typeof connectionPages>,
  value: unknown,
  alreadyReceived: number,
  scope: string,
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
    throw new Error(`GitHub returned invalid ${scope} pages`);
  const received = alreadyReceived + nodes.length;
  if (hasNextPage ? received >= totalCount : received !== totalCount)
    throw new Error(`GitHub returned incomplete ${scope} pages`);
  page.total = totalCount;
  page.done = !hasNextPage;
  if (hasNextPage) {
    if (!nodes.length || !nonempty(endCursor) || page.cursors.has(endCursor))
      throw new Error(`GitHub returned an incomplete ${scope} cursor`);
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
