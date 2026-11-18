import { isDeepStrictEqual } from "node:util";
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
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const { response, commandError } = await client.graphql(query, variables);
  signal?.throwIfAborted();
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

function parseIssuePage<T>(
  value: unknown,
  owner: string,
  connection: Connection,
  parse: (node: Record<string, unknown>) => T,
) {
  const page = object(value);
  const { nodes, totalCount } = page;
  const { hasNextPage, endCursor } = object(page.pageInfo);
  if (
    !Array.isArray(nodes) ||
    typeof totalCount !== "number" ||
    !Number.isSafeInteger(totalCount) ||
    totalCount < 0 ||
    typeof hasNextPage !== "boolean"
  )
    throw new Error(
      `GitHub returned invalid ${connection} pagination for Issue ${owner}`,
    );
  if (
    !nonempty(endCursor) &&
    (endCursor !== null || hasNextPage || nodes.length > 0)
  )
    throw new Error(
      `GitHub returned invalid ${connection} cursor for Issue ${owner}`,
    );
  return {
    nodes: nodes.map((node) => parse(object(node))),
    totalCount,
    hasNextPage,
    endCursor,
  };
}

type ReadIssueGraphQL = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

async function readIssueConnection<T extends { id: string }>(
  read: ReadIssueGraphQL,
  owner: string,
  connection: Connection,
  fields: string,
  initialPage: ReturnType<typeof parseIssuePage<T>>,
  parse: (node: Record<string, unknown>) => T,
): Promise<T[]> {
  const entries = new Map<string, T>();
  const cursors = new Set<string>();
  let page = initialPage;
  for (;;) {
    const { nodes, totalCount, hasNextPage, endCursor } = page;
    if (totalCount !== initialPage.totalCount)
      throw new Error(
        `GitHub returned invalid ${connection} pagination for Issue ${owner}`,
      );
    if (endCursor !== null && cursors.has(endCursor))
      throw new Error(
        `GitHub returned invalid ${connection} cursor for Issue ${owner}`,
      );
    for (const entry of nodes) {
      const previous = entries.get(entry.id);
      if (previous && !isDeepStrictEqual(previous, entry))
        throw new Error(
          `GitHub returned conflicting ${connection} facts for node ${entry.id}`,
        );
      entries.set(entry.id, entry);
    }
    if (!hasNextPage) {
      if (entries.size !== totalCount)
        throw new Error(
          `GitHub returned incomplete ${connection} for Issue ${owner}`,
        );
      return [...entries.values()];
    }
    if (entries.size > totalCount)
      throw new Error(
        `GitHub returned inconsistent ${connection} for Issue ${owner}`,
      );
    // A continuing page always supplies a validated cursor.
    if (endCursor === null)
      throw new Error(
        `GitHub returned invalid ${connection} cursor for Issue ${owner}`,
      );
    cursors.add(endCursor);
    const data = await read(
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
    page = parseIssuePage(issue[connection], owner, connection, parse);
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
  signal?: AbortSignal,
) {
  const read: ReadIssueGraphQL = (query, variables) =>
    readIssueGraphQL(client, query, variables, signal);
  const [owner, name] = repository.split("/");
  const childFields = `
    ${issueFields}
    ${issueConnectionFields("labels", "id name")}
    ${issueConnectionFields("assignees", "id login")}
    ${issueConnectionFields("blockedBy", issueFields)}
  `;
  const data = await read(
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
  const reservation =
    repo.label === null ? null : parseLabel(object(repo.label));
  const runner = data.user === null ? null : parseAssignee(object(data.user));
  if (
    (reservation && reservation.name !== reservationLabel) ||
    (runner && runner.login.toLowerCase() !== runnerAccount.toLowerCase())
  )
    throw new Error("GitHub returned unexpected Reservation marker identities");

  const numbers = new Map([
    [`${parent.repositoryId}#${parent.number}`, parent.id],
  ]);
  const parseChild = (raw: Record<string, unknown>) => {
    const child = parseIssueFact(raw);
    const identity = `${child.repositoryId}#${child.number}`;
    const seen = numbers.get(identity);
    if (child.id === parent.id || (seen !== undefined && seen !== child.id))
      throw new Error(
        `GitHub returned an inconsistent child identity for #${child.number}`,
      );
    numbers.set(identity, child.id);
    return {
      ...child,
      labels: parseIssuePage(raw.labels, child.id, "labels", parseLabel),
      assignees: parseIssuePage(
        raw.assignees,
        child.id,
        "assignees",
        parseAssignee,
      ),
      blockers: parseIssuePage(
        raw.blockedBy,
        child.id,
        "blockedBy",
        parseIssueFact,
      ),
    };
  };
  const observed = await readIssueConnection(
    read,
    parent.id,
    "subIssues",
    childFields,
    parseIssuePage(issue.subIssues, parent.id, "subIssues", parseChild),
    parseChild,
  );
  const children: ParentDiscoveryChild[] = [];
  for (const child of observed) {
    children.push({
      ...child,
      labels: await readIssueConnection(
        read,
        child.id,
        "labels",
        "id name",
        child.labels,
        parseLabel,
      ),
      assignees: await readIssueConnection(
        read,
        child.id,
        "assignees",
        "id login",
        child.assignees,
        parseAssignee,
      ),
      blockers: await readIssueConnection(
        read,
        child.id,
        "blockedBy",
        issueFields,
        child.blockers,
        parseIssueFact,
      ),
    });
  }
  return { parent, children, reservation, runner };
}
