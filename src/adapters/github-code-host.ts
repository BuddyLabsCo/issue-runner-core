import type {
  CodeHost,
  BranchObservation,
  PublicationObservation,
  PublicationQuery,
  PullRequestRecord,
  PullRequestQuery,
  PullRequestObservation,
  DeliveryObservation,
  MergeRequestResult,
} from "../run/contracts.ts";
import { nonempty, object } from "../agent/handoff.ts";
import { GitHubClient, type GitHubCommand } from "./github-client.ts";
import {
  branchFields,
  mergeFields,
  oid,
  publicationFields,
  parseCheckContext,
  parseMergeFacts,
  pollQuery,
  requiredChecks,
} from "./github-pr-checks.ts";
import { issueFields, parseIssueFact } from "./github-issue-facts.ts";
import {
  connectionPages,
  parseBranch,
  parsePullRequest,
  readConnectionPage,
  sameRepository,
} from "./github-pr-evidence.ts";

export class GitHubCodeHost implements CodeHost {
  private readonly client: GitHubClient;

  constructor(token: string, command?: GitHubCommand) {
    this.client = new GitHubClient(token, command);
  }

  async observeDelivery(
    { repository, number, ticket }: Parameters<CodeHost["observeDelivery"]>[0],
    signal?: AbortSignal,
  ): Promise<DeliveryObservation> {
    const [owner, name] = repository.split("/");
    const page = connectionPages();
    const labels: string[] = [];
    let previous: string | undefined;
    for (;;) {
      signal?.throwIfAborted();
      const data = await this.graphqlData(
        deliveryQuery,
        { owner, name, number, ticket, after: page.after },
        "delivery",
      );
      signal?.throwIfAborted();
      const remote = object(data.repository);
      const { id: repositoryId } = remote;
      const { name: defaultBranch } = object(remote.defaultBranchRef);
      if (
        !sameRepository(remote, repository) ||
        !nonempty(repositoryId) ||
        !nonempty(defaultBranch)
      )
        throw new Error("GitHub returned an unexpected delivery repository");
      const row = object(remote.pullRequest);
      const pullRequest = parsePullRequest(row, repository, repositoryId);
      const merge = parseMergeFacts(row, number);
      const rawIssue = object(remote.issue);
      const issue = parseIssueFact(rawIssue);
      if (
        pullRequest.number !== number ||
        issue.number !== ticket ||
        !sameRepository(row.headRepository, repository) ||
        object(row.headRepository).id !== repositoryId ||
        issue.repositoryId !== repositoryId ||
        issue.repository.toLowerCase() !== repository.toLowerCase()
      )
        throw new Error(
          "GitHub returned unexpected Pull Request or Issue delivery identity",
        );
      const evidence = JSON.stringify([
        repositoryId,
        defaultBranch,
        pullRequest,
        merge,
        issue,
      ]);
      if (previous !== undefined && evidence !== previous)
        throw new Error(
          "Delivery evidence changed during Issue label pagination",
        );
      previous = evidence;
      for (const { name } of readConnectionPage(
        page,
        rawIssue.labels,
        "Issue label",
      )) {
        if (!nonempty(name))
          throw new Error("GitHub returned an invalid Issue label");
        labels.push(name);
      }
      if (page.done)
        return {
          repositoryId,
          defaultBranch,
          pullRequest,
          merge,
          issue: { ...issue, labels },
        };
    }
  }

  async requestSquashMerge(
    input: Parameters<CodeHost["requestSquashMerge"]>[0],
  ): Promise<MergeRequestResult> {
    const mutation = input.autoMerge
      ? "enablePullRequestAutoMerge"
      : "mergePullRequest";
    const type = input.autoMerge
      ? "EnablePullRequestAutoMergeInput"
      : "MergePullRequestInput";
    try {
      const data = await this.graphqlData(
        `mutation RequestSquash($input: ${type}!) {
          ${mutation}(input: $input) {
            pullRequest {
              id number headRefOid state mergedAt
              ${input.autoMerge ? "autoMergeRequest { enabledAt } mergeQueueEntry { id }" : ""}
            }
          }
        }`,
        {
          input: {
            pullRequestId: input.pullRequest.id,
            expectedHeadOid: input.headSha,
            mergeMethod: "SQUASH",
          },
        },
        "merge request",
      );
      const pr = object(object(data[mutation]).pullRequest);
      const merged =
        pr.state === "MERGED" &&
        typeof pr.mergedAt === "string" &&
        Number.isFinite(Date.parse(pr.mergedAt));
      const queued =
        input.autoMerge &&
        pr.state === "OPEN" &&
        pr.mergedAt === null &&
        acceptedAutoMerge(pr);
      if (
        pr.id !== input.pullRequest.id ||
        pr.number !== input.pullRequest.number ||
        pr.headRefOid !== input.headSha ||
        (!merged && !queued)
      )
        throw new Error(
          "GitHub returned incomplete or mismatched merge request evidence",
        );
      return { outcome: "accepted" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        outcome:
          /(?:^|gh: |"message":")(?:merge conflicts? (?:in|detected)|pull request cannot be cleanly created)\b/iu.test(
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
      source: connectionPages(),
      target: connectionPages(),
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

  private async graphqlData(
    query: string,
    variables: Record<string, unknown>,
    operation = "publication",
  ) {
    const result = await this.client.graphql(query, variables);
    if (
      result.commandError ||
      result.response.errors?.length ||
      !result.response.data
    )
      throw new Error(
        result.commandError?.message ??
          (operation !== "publication" && result.response.errors?.length
            ? `GitHub ${operation} failed: ${JSON.stringify(result.response.errors)}`
            : `GitHub returned incomplete ${operation} data`),
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

const deliveryQuery = `
  query Delivery($owner: String!, $name: String!, $number: Int!, $ticket: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      id nameWithOwner defaultBranchRef { name }
      pullRequest(number: $number) { ${publicationFields} ${mergeFields} }
      issue(number: $ticket) {
        ${issueFields}
        labels(first: 100, after: $after) {
          nodes { id name }
          pageInfo { hasNextPage endCursor }
          totalCount
        }
      }
    }
  }
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

function acceptedAutoMerge(pr: Record<string, unknown>): boolean {
  const queueId =
    pr.mergeQueueEntry === null ? null : object(pr.mergeQueueEntry).id;
  const enabledAt =
    pr.autoMergeRequest === null ? null : object(pr.autoMergeRequest).enabledAt;
  return (
    nonempty(queueId) ||
    (typeof enabledAt === "string" && Number.isFinite(Date.parse(enabledAt)))
  );
}

interface PublicationCandidate {
  record: PullRequestRecord;
  sameHeadRepository: boolean;
}

function collectPublicationPage(input: {
  page: ReturnType<typeof connectionPages>;
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
  for (const row of readConnectionPage(page, value, "Pull Request")) {
    const record = parsePullRequest(row, repository, repositoryId);
    const actualBranch =
      scope === "source" ? record.branch : record.targetBranch;
    if (actualBranch !== expectedBranch)
      throw new Error("GitHub returned inconsistent Pull Request pages");
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
