import type {
  CodeHost,
  PublicationPullRequest,
  PullRequestState,
} from "../run/contracts.ts";
import type { GitHubClient } from "./github-client.ts";
import { parseIssueFact } from "./github-parent-observation.ts";

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("GitHub returned incomplete delivery observation");
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim())
    throw new Error("GitHub returned invalid delivery observation");
  return value;
};

export async function observeDelivery(
  client: GitHubClient,
  input: Parameters<CodeHost["observeDelivery"]>[0],
) {
  const [owner, name] = input.repository.split("/");
  let after: string | null = null;
  const cursors = new Set<string>();
  const labelIds = new Set<string>();
  const labels: string[] = [];
  let first:
    | {
        pullRequest: PublicationPullRequest;
        state: PullRequestState;
        ticket: ReturnType<typeof parseIssueFact>;
      }
    | undefined;
  let total: number | undefined;
  do {
    const response = await client.graphql(
      `query($owner:String!,$name:String!,$number:Int!,$issue:Int!,$after:String){repository(owner:$owner,name:$name){id nameWithOwner pullRequest(number:$number){id number url headRefName baseRefName headRefOid state isDraft createdAt mergedAt mergeable mergeStateStatus isInMergeQueue isMergeQueueEnabled autoMergeRequest{enabledAt} mergeQueueEntry{id}} issue(number:$issue){id number state stateReason repository{id nameWithOwner} labels(first:100,after:$after){totalCount nodes{id name} pageInfo{hasNextPage endCursor}}}}}`,
      { owner, name, number: input.pullRequest, issue: input.ticket, after },
    );
    if (response.commandError || response.errors !== undefined)
      throw new Error("GitHub returned incomplete delivery observation", {
        cause: response,
      });
    const repo = object(object(response.data).repository);
    if (
      text(repo.nameWithOwner).toLowerCase() !== input.repository.toLowerCase()
    )
      throw new Error("Delivery repository mismatch");
    const row = object(repo.pullRequest);
    const ticket = parseIssueFact(repo.issue);
    if (
      ticket.number !== input.ticket ||
      ticket.repositoryId !== text(repo.id) ||
      ticket.repository?.toLowerCase() !== input.repository.toLowerCase()
    )
      throw new Error("Delivery Issue mismatch");
    if (
      row.number !== input.pullRequest ||
      typeof row.isDraft !== "boolean" ||
      !["OPEN", "CLOSED", "MERGED"].includes(String(row.state)) ||
      !["MERGEABLE", "CONFLICTING", "UNKNOWN"].includes(
        String(row.mergeable),
      ) ||
      typeof row.mergeStateStatus !== "string" ||
      ![
        "BEHIND",
        "BLOCKED",
        "CLEAN",
        "DIRTY",
        "DRAFT",
        "HAS_HOOKS",
        "UNKNOWN",
        "UNSTABLE",
      ].includes(row.mergeStateStatus) ||
      typeof row.isInMergeQueue !== "boolean" ||
      typeof row.isMergeQueueEnabled !== "boolean" ||
      ![row.autoMergeRequest, row.mergeQueueEntry].every(
        (v) =>
          v === null || (!!v && typeof v === "object" && !Array.isArray(v)),
      ) ||
      (row.mergedAt !== null &&
        (typeof row.mergedAt !== "string" ||
          !Number.isFinite(Date.parse(row.mergedAt)))) ||
      (row.state === "MERGED") !== (row.mergedAt !== null)
    )
      throw new Error("GitHub returned invalid delivery state");
    const head = text(row.headRefOid);
    const createdAt = text(row.createdAt);
    if (
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head) ||
      !Number.isFinite(Date.parse(createdAt))
    )
      throw new Error("GitHub returned invalid delivery identity");
    const pullRequest: PublicationPullRequest = {
      id: text(row.id),
      number: input.pullRequest,
      url: text(row.url),
      branch: text(row.headRefName),
      targetBranch: text(row.baseRefName),
      headSha: head,
      state: String(row.state).toLowerCase() as PublicationPullRequest["state"],
      draft: row.isDraft,
      createdAt,
    };
    const merged = row.state === "MERGED" && row.mergedAt !== null;
    const state: PullRequestState = {
      headSha: head,
      createdAt,
      merged,
      mergeRequested:
        row.autoMergeRequest !== null ||
        row.mergeQueueEntry !== null ||
        row.isInMergeQueue,
      mergeable:
        row.mergeable === "MERGEABLE"
          ? "mergeable"
          : row.mergeable === "CONFLICTING"
            ? "conflicting"
            : "unknown",
      mergeFailure:
        row.state === "CLOSED"
          ? `Pull Request ${input.pullRequest} closed without merging`
          : null,
      mergeStateStatus: row.mergeStateStatus,
      isInMergeQueue: row.isInMergeQueue,
      isMergeQueueEnabled: row.isMergeQueueEnabled,
    };
    const current = { pullRequest, state, ticket };
    if (first && JSON.stringify(first) !== JSON.stringify(current))
      throw new Error("Delivery observation changed during pagination");
    first = current;
    const connection = object(object(repo.issue).labels);
    const page = object(connection.pageInfo);
    if (
      !Array.isArray(connection.nodes) ||
      !Number.isSafeInteger(connection.totalCount) ||
      (connection.totalCount as number) < 0 ||
      (total !== undefined && total !== connection.totalCount) ||
      typeof page.hasNextPage !== "boolean" ||
      (page.endCursor !== null && typeof page.endCursor !== "string")
    )
      throw new Error("GitHub returned incomplete delivery labels");
    total = connection.totalCount as number;
    for (const node of connection.nodes) {
      const label = object(node);
      const id = text(label.id);
      if (labelIds.has(id))
        throw new Error("GitHub returned duplicate delivery label");
      labelIds.add(id);
      labels.push(text(label.name));
    }
    if (page.hasNextPage) {
      const cursor = text(page.endCursor);
      if (
        cursors.has(cursor) ||
        connection.nodes.length === 0 ||
        labels.length >= total
      )
        throw new Error("GitHub returned invalid delivery cursor");
      cursors.add(cursor);
      after = cursor;
    } else {
      if (labels.length !== total)
        throw new Error("GitHub returned truncated delivery labels");
      after = null;
    }
  } while (after !== null);
  return { ...first, ticket: { ...first.ticket, labels } };
}
