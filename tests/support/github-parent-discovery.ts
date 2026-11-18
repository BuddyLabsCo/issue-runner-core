export const repository = { id: "repo-id", nameWithOwner: "owner/repo" };
export const reservation = { id: "reserved-id", name: "runner:reserved" };
export const runner = { id: "runner-id", login: "runner" };
export const runnerNotFound = {
  type: "NOT_FOUND",
  path: ["user"],
  message: "Could not resolve to a User with the login of 'runner'.",
};
export const config = {
  reservationLabel: reservation.name,
  runnerAccount: runner.login,
};

export function issue(number: number, fields: Record<string, unknown> = {}) {
  return {
    id: `issue-${number}`,
    number,
    repository,
    state: "OPEN",
    stateReason: null,
    ...fields,
  };
}

export function connection(
  nodes: object[],
  totalCount = nodes.length,
  cursor: string | null = nodes.length ? "page-end" : null,
  hasNextPage = false,
) {
  return { nodes, totalCount, pageInfo: { hasNextPage, endCursor: cursor } };
}

export function child(number: number, fields: Record<string, unknown> = {}) {
  return issue(number, {
    labels: connection([]),
    assignees: connection([]),
    blockedBy: connection([]),
    ...fields,
  });
}

export function observation(subIssues: object) {
  return {
    data: {
      repository: {
        ...repository,
        label: reservation,
        issue: issue(48, { subIssues }),
      },
      user: runner,
    },
  };
}
