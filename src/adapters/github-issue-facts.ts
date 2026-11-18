import { nonempty, object } from "../agent/handoff.ts";
import type {
  IssueFact,
  ParentDiscoveryChild,
  Tracker,
} from "../run/contracts.ts";
import type { GitHubClient } from "./github-client.ts";

const issueFields =
  "id number state stateReason repository { id nameWithOwner }";

function parseIssueFact(issue: Record<string, unknown>): IssueFact {
  const repository = object(issue.repository);
  if (
    !nonempty(issue.id) ||
    !nonempty(repository.id) ||
    !nonempty(repository.nameWithOwner)
  )
    throw new Error("GitHub issue has an invalid identity");
  if (
    typeof issue.number !== "number" ||
    !Number.isSafeInteger(issue.number) ||
    issue.number <= 0
  )
    throw new Error("GitHub issue has no valid number");
  const identity = {
    id: issue.id,
    number: issue.number,
    repository: repository.nameWithOwner,
    repositoryId: repository.id,
  };
  if (
    issue.state === "OPEN" &&
    (issue.stateReason === null || issue.stateReason === "REOPENED")
  )
    return { ...identity, state: "open", stateReason: null };
  if (
    issue.state !== "CLOSED" ||
    (issue.stateReason !== "COMPLETED" && issue.stateReason !== "NOT_PLANNED")
  )
    throw new Error(`Issue ${issue.number} has an unsupported terminal state`);
  return {
    ...identity,
    state: "closed",
    stateReason:
      issue.stateReason === "COMPLETED" ? "completed" : "not_planned",
  };
}

async function readIssueGraphQL(
  client: GitHubClient,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { response, commandError } = await client.graphql(query, variables);
  if (response.errors?.length)
    throw new Error(
      `GitHub GraphQL Issue read failed: ${JSON.stringify(response.errors)}`,
      {
        cause: commandError,
      },
    );
  if (commandError) throw commandError;
  return object(response.data);
}

type Connection = "subIssues" | "labels" | "assignees" | "blockedBy";

function issueConnectionFields(
  connection: Connection,
  fields: string,
  after = "",
): string {
  return `${connection}(first: 100${after}) {
    nodes { ${fields} }
    totalCount
    pageInfo { hasNextPage endCursor }
  }`;
}

async function readIssueConnection<T extends { id: string }>(
  client: GitHubClient,
  owner: string,
  connection: Connection,
  fields: string,
  initialPage: unknown,
  parse: (node: Record<string, unknown>) => T,
): Promise<T[]> {
  const entries = new Map<string, T>();
  const cursors = new Set<string>();
  let total: number | undefined;
  let page = object(initialPage);
  for (;;) {
    const { nodes, totalCount } = page;
    const { hasNextPage, endCursor } = object(page.pageInfo);
    if (
      !Array.isArray(nodes) ||
      typeof totalCount !== "number" ||
      !Number.isSafeInteger(totalCount) ||
      totalCount < 0 ||
      (total !== undefined && total !== totalCount) ||
      typeof hasNextPage !== "boolean" ||
      (endCursor !== null && !nonempty(endCursor))
    )
      throw new Error(
        `GitHub returned invalid ${connection} pagination for Issue ${owner}`,
      );
    if (
      (hasNextPage && endCursor === null) ||
      (endCursor !== null && cursors.has(endCursor))
    )
      throw new Error(
        `GitHub returned invalid ${connection} cursor for Issue ${owner}`,
      );
    total = totalCount;
    for (const node of nodes) {
      const entry = parse(object(node));
      if (!entries.has(entry.id)) entries.set(entry.id, entry);
    }
    if (!hasNextPage) {
      if (entries.size !== total)
        throw new Error(
          `GitHub returned incomplete ${connection} for Issue ${owner}`,
        );
      return [...entries.values()];
    }
    if (entries.size > total)
      throw new Error(
        `GitHub returned inconsistent ${connection} for Issue ${owner}`,
      );
    // A continuing page always supplies a validated cursor.
    if (endCursor === null)
      throw new Error(
        `GitHub returned invalid ${connection} cursor for Issue ${owner}`,
      );
    cursors.add(endCursor);
    const data = await readIssueGraphQL(
      client,
      `query IssueConnection($owner: ID!, $after: String!) {
        node(id: $owner) {
          ... on Issue {
            id
            ${issueConnectionFields(connection, fields, ", after: $after")}
          }
        }
      }`,
      { owner, after: endCursor },
    );
    const issue = object(data.node);
    if (issue.id !== owner)
      throw new Error(
        `GitHub returned the wrong Issue for ${connection} pagination`,
      );
    page = object(issue[connection]);
  }
}

function parseLabel({ id, name }: Record<string, unknown>) {
  if (!nonempty(id) || !nonempty(name))
    throw new Error("GitHub returned an invalid Issue label");
  return { id, name };
}

function parseAssignee({ id, login }: Record<string, unknown>) {
  if (!nonempty(id) || !nonempty(login))
    throw new Error("GitHub returned an invalid Issue assignee");
  return { id, login };
}

export async function discoverParent(
  client: GitHubClient,
  repository: string,
  parentTicket: number,
  { reservationLabel, runnerAccount }: Parameters<Tracker["discoverParent"]>[2],
) {
  const [owner, name] = repository.split("/");
  const childFields = `
    ${issueFields}
    ${issueConnectionFields("labels", "id name")}
    ${issueConnectionFields("assignees", "id login")}
    ${issueConnectionFields("blockedBy", issueFields)}
  `;
  const data = await readIssueGraphQL(
    client,
    `query ParentDiscovery($owner: String!, $name: String!, $number: Int!, $reservation: String!, $runner: String!) {
      repository(owner: $owner, name: $name) {
        id nameWithOwner
        label(name: $reservation) { id name }
        issue(number: $number) {
          ${issueFields}
          ${issueConnectionFields("subIssues", childFields)}
        }
      }
      user(login: $runner) { id login }
    }`,
    {
      owner,
      name,
      number: parentTicket,
      reservation: reservationLabel,
      runner: runnerAccount,
    },
  );
  const repo = object(data.repository);
  const issue = object(repo.issue);
  const parent = parseIssueFact(issue);
  if (
    parent.number !== parentTicket ||
    parent.repository !== repository ||
    repo.nameWithOwner !== repository ||
    repo.id !== parent.repositoryId
  )
    throw new Error("Unexpected Parent Ticket ownership");
  const reservation = parseLabel(object(repo.label));
  const runner = parseAssignee(object(data.user));
  if (
    reservation.name !== reservationLabel ||
    runner.login.toLowerCase() !== runnerAccount.toLowerCase()
  )
    throw new Error("GitHub returned unexpected Reservation marker identities");

  const numbers = new Map([[parent.number, parent.id]]);
  const ids = new Map([[parent.id, parent.number]]);
  const observed = await readIssueConnection(
    client,
    parent.id,
    "subIssues",
    childFields,
    issue.subIssues,
    (raw) => {
      const child = parseIssueFact(raw);
      if (
        child.repository !== repository ||
        child.repositoryId !== parent.repositoryId
      )
        throw new Error(
          `cross-repository child ${child.repository}#${child.number} is unsupported`,
        );
      const seen = numbers.get(child.number);
      const seenNumber = ids.get(child.id);
      if (
        child.number === parent.number ||
        (seen !== undefined && seen !== child.id) ||
        (seenNumber !== undefined && seenNumber !== child.number)
      )
        throw new Error(
          `GitHub returned an inconsistent child identity for #${child.number}`,
        );
      numbers.set(child.number, child.id);
      ids.set(child.id, child.number);
      return { id: child.id, child, raw };
    },
  );
  const children: ParentDiscoveryChild[] = [];
  for (const { id, child, raw } of observed) {
    children.push({
      ...child,
      labels: await readIssueConnection(
        client,
        id,
        "labels",
        "id name",
        raw.labels,
        parseLabel,
      ),
      assignees: await readIssueConnection(
        client,
        id,
        "assignees",
        "id login",
        raw.assignees,
        parseAssignee,
      ),
      blockers: await readIssueConnection(
        client,
        id,
        "blockedBy",
        issueFields,
        raw.blockedBy,
        parseIssueFact,
      ),
    });
  }
  return { parent, children, reservation, runner };
}
