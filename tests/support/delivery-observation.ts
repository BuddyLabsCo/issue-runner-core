import type {
  CodeHost,
  DeliveryObservation,
  PullRequestMergeFacts,
  PullRequestRecord,
  PullRequestState,
  Ticket,
} from "../../src/run/contracts.ts";

export function issueIdentity(repository: string, ticket: Ticket) {
  return {
    number: ticket.number,
    state: ticket.state,
    stateReason: ticket.stateReason,
    repository: ticket.repository ?? repository,
    repositoryId: ticket.repository ?? repository,
    id: `${ticket.repository ?? repository}#${ticket.number}`,
  };
}

export async function observeDelivery(
  this: {
    listPullRequests(): Promise<PullRequestRecord[]>;
    deliveryMergeFacts(
      repository: string,
      number: number,
    ): Promise<PullRequestState & Partial<PullRequestMergeFacts>>;
    readDeliveryIssue(repository: string, ticket: number): Promise<Ticket>;
  },
  { repository, number, ticket }: Parameters<CodeHost["observeDelivery"]>[0],
): Promise<DeliveryObservation> {
  const record = (await this.listPullRequests()).find(
    (pr) => pr.number === number,
  );
  if (!record) throw new Error("Delivery Pull Request is missing");
  const observed = await this.deliveryMergeFacts(repository, number);
  const issue = await this.readDeliveryIssue(repository, ticket);
  return {
    repositoryId: "R_repo",
    defaultBranch: "default-branch",
    pullRequest: {
      ...record,
      headSha: observed.headSha,
      state: observed.merged
        ? "merged"
        : observed.mergeFailure
          ? "closed"
          : record.state,
    },
    merge: {
      mergeStateStatus: "UNKNOWN",
      isInMergeQueue: observed.mergeRequested,
      isMergeQueueEnabled: false,
      autoMergeEnabledAt: null,
      mergeQueueEntryId: null,
      ...observed,
      createdAt: record.createdAt,
    },
    issue: {
      ...issueIdentity(repository, issue),
      repositoryId: "R_repo",
      labels: issue.labels ?? [],
    },
  };
}
