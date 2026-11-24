import { isDeepStrictEqual } from "node:util";
import { nonempty, object } from "../agent/handoff.ts";
import type {
  IssueFact,
  IssueStartFacts,
  ParentDiscoveryChild,
  ParentObservation,
  Tracker,
  ViewerIdentity,
} from "../run/contracts.ts";
import type { GitHubClient } from "./github-client.ts";

import {
  issueFields,
  parseIssueFact,
  scopedIssue,
} from "./github-issue-identity.ts";

const viewerError =
  "gh must be authenticated as a normal GitHub user; GitHub did not resolve the authenticated viewer";

async function requestIssueGraphQL(
  client: GitHubClient,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const { response, commandError } = await client.graphql(query, variables);
  signal?.throwIfAborted();
  if (response.errors?.length) {
    if (
      response.data !== null &&
      response.data !== undefined &&
      "viewer" in response.data &&
      response.data.viewer === null
    )
      throw new Error(viewerError, { cause: commandError });
    throw new Error(
      `GitHub GraphQL Issue request failed: ${JSON.stringify(response.errors)}`,
      {
        cause: commandError,
      },
    );
  }
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

function parseViewer(value: unknown): ViewerIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(viewerError);
  const { __typename, id, login } = value as Record<string, unknown>;
  const bot = nonempty(login) && login.toLowerCase().endsWith("[bot]");
  if (__typename !== "User" || !nonempty(id) || !nonempty(login) || bot)
    throw new Error(viewerError);
  return { id, login };
}

export const markerFields = [
  issueConnectionFields("labels", "id name"),
  issueConnectionFields("assignees", "id login"),
].join("\n");
const childFields = `${issueFields} ${markerFields} ${issueConnectionFields("blockedBy", issueFields)}`;

function parseMarkerPages(raw: Record<string, unknown>, id: string) {
  return {
    labels: parseIssuePage(raw.labels, id, "labels", parseLabel),
    assignees: parseIssuePage(raw.assignees, id, "assignees", parseAssignee),
  };
}

async function readMarkers(
  read: ReadIssueGraphQL,
  id: string,
  pages: ReturnType<typeof parseMarkerPages>,
) {
  return {
    labels: await readIssueConnection(
      read,
      id,
      "labels",
      "id name",
      pages.labels,
      parseLabel,
    ),
    assignees: await readIssueConnection(
      read,
      id,
      "assignees",
      "id login",
      pages.assignees,
      parseAssignee,
    ),
  };
}

export function readIssueMarkers(
  client: GitHubClient,
  id: string,
  raw: Record<string, unknown>,
  signal?: AbortSignal,
) {
  return readMarkers(
    (query, variables) => requestIssueGraphQL(client, query, variables, signal),
    id,
    parseMarkerPages(raw, id),
  );
}

function markerLookup(
  repo: Record<string, unknown>,
  viewer: unknown,
  { reservationLabel }: Parameters<Tracker["discoverParent"]>[2],
) {
  const reservation =
    repo.label === null ? null : parseLabel(object(repo.label));
  if (reservation && reservation.name !== reservationLabel)
    throw new Error("GitHub returned unexpected Reservation marker identities");
  return { reservation, viewer: parseViewer(viewer) };
}

function readScopeChildren<T extends IssueFact>(
  read: ReadIssueGraphQL,
  parent: IssueFact,
  rawChildren: unknown,
  fields: string,
  parseChild: (raw: Record<string, unknown>, child: IssueFact) => T,
) {
  const numbers = new Map([
    [`${parent.repositoryId}#${parent.number}`, parent.id],
  ]);
  const parse = (raw: Record<string, unknown>) => {
    const child = parseIssueFact(raw);
    const identity = `${child.repositoryId}#${child.number}`;
    const seen = numbers.get(identity);
    if (child.id === parent.id || (seen !== undefined && seen !== child.id))
      throw new Error(
        `GitHub returned an inconsistent child identity for #${child.number}`,
      );
    numbers.set(identity, child.id);
    return parseChild(raw, child);
  };
  return readIssueConnection(
    read,
    parent.id,
    "subIssues",
    fields,
    parseIssuePage(rawChildren, parent.id, "subIssues", parse),
    parse,
  );
}

const parentScopeFields = `${issueFields} ${issueConnectionFields("subIssues", issueFields)}`;

async function readParentObservation(
  read: ReadIssueGraphQL,
  parent: IssueFact,
  raw: Record<string, unknown>,
): Promise<ParentObservation> {
  const children = await readScopeChildren(
    read,
    parent,
    raw.subIssues,
    issueFields,
    (_raw, child) => child,
  );
  return { parent, children };
}

export async function readParentCompletion(
  client: GitHubClient,
  repository: string,
  parentTicket: number,
  signal?: AbortSignal,
): Promise<ParentObservation> {
  const read: ReadIssueGraphQL = (query, variables) =>
    requestIssueGraphQL(client, query, variables, signal);
  const [owner, name] = repository.split("/");
  const data = await read(
    `query ParentCompletion($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        id nameWithOwner
        issue(number: $number) { ${parentScopeFields} }
      }
    }`,
    { owner, name, number: parentTicket },
  );
  const repo = object(data.repository);
  const raw = object(repo.issue);
  const parent = scopedIssue(
    raw,
    repo,
    repository,
    parentTicket,
    "Parent Ticket",
  );
  return readParentObservation(read, parent, raw);
}

export async function closeParent(
  client: GitHubClient,
  expected: IssueFact,
  signal?: AbortSignal,
): Promise<ParentObservation> {
  const read: ReadIssueGraphQL = (query, variables) =>
    requestIssueGraphQL(client, query, variables, signal);
  const data = await read(
    `mutation CompleteParent($parent: ID!) {
      closeIssue(input: { issueId: $parent, stateReason: COMPLETED }) {
        issue { ${parentScopeFields} }
      }
    }`,
    { parent: expected.id },
  );
  const raw = object(object(data.closeIssue).issue);
  const parent = parseIssueFact(raw);
  if (
    parent.id !== expected.id ||
    parent.number !== expected.number ||
    parent.repositoryId !== expected.repositoryId ||
    parent.repository.toLowerCase() !== expected.repository.toLowerCase() ||
    parent.state !== "closed" ||
    parent.stateReason !== "completed"
  )
    throw new Error("Parent closure has not been confirmed");
  return readParentObservation(read, parent, raw);
}

export async function discoverParent(
  client: GitHubClient,
  repository: string,
  parentTicket: number,
  { reservationLabel }: Parameters<Tracker["discoverParent"]>[2],
  signal?: AbortSignal,
) {
  const read: ReadIssueGraphQL = (query, variables) =>
    requestIssueGraphQL(client, query, variables, signal);
  const [owner, name] = repository.split("/");
  const data = await read(
    `query ParentDiscovery($owner: String!, $name: String!, $number: Int!, $reservation: String!) {
      repository(owner: $owner, name: $name) {
        id nameWithOwner
        label(name: $reservation) { id name }
        issue(number: $number) {
          ${issueFields}
          ${issueConnectionFields("subIssues", childFields)}
        }
      }
      viewer { __typename id login }
    }`,
    {
      owner,
      name,
      number: parentTicket,
      reservation: reservationLabel,
    },
  );
  const repo = object(data.repository);
  const issue = object(repo.issue);
  const parent = scopedIssue(
    issue,
    repo,
    repository,
    parentTicket,
    "Parent Ticket",
  );
  const lookup = markerLookup(repo, data.viewer, { reservationLabel });
  const observed = await readScopeChildren(
    read,
    parent,
    issue.subIssues,
    childFields,
    (raw, child) => ({
      ...child,
      ...parseMarkerPages(raw, child.id),
      blockers: parseIssuePage(
        raw.blockedBy,
        child.id,
        "blockedBy",
        parseIssueFact,
      ),
    }),
  );
  const children: ParentDiscoveryChild[] = [];
  for (const child of observed) {
    children.push({
      ...child,
      ...(await readMarkers(read, child.id, child)),
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
  return { parent, children, ...lookup };
}

export async function readIssueStart(
  client: GitHubClient,
  repository: string,
  number: number,
  markers: Parameters<Tracker["readIssueStart"]>[2],
  parentTicket?: number,
  signal?: AbortSignal,
): Promise<IssueStartFacts> {
  const read: ReadIssueGraphQL = (query, variables) =>
    requestIssueGraphQL(client, query, variables, signal);
  const [owner, name] = repository.split("/");
  const parentField =
    parentTicket === undefined
      ? ""
      : `
    configuredParent: issue(number: $parent) {
      ${parentScopeFields}
    }
  `;
  const data = await read(
    `query IssueStart($owner: String!, $name: String!, $number: Int!, $reservation: String!${parentField ? ", $parent: Int!" : ""}) {
      repository(owner: $owner, name: $name) {
        id nameWithOwner
        label(name: $reservation) { id name }
        target: issue(number: $number) { ${childFields} title body url }
        ${parentField}
      }
      viewer { __typename id login }
    }`,
    {
      owner,
      name,
      number,
      reservation: markers.reservationLabel,
      ...(parentTicket === undefined ? {} : { parent: parentTicket }),
    },
  );
  const repo = object(data.repository);
  const target = object(repo.target);
  const issue = scopedIssue(target, repo, repository, number, "Issue");
  const lookup = markerLookup(repo, data.viewer, markers);
  const { title, body, url } = target;
  if (!nonempty(title) || typeof body !== "string" || !nonempty(url))
    throw new Error("GitHub issue has an invalid review snapshot");
  let scope: IssueStartFacts["scope"];
  if (parentTicket !== undefined) {
    const rawParent = object(repo.configuredParent);
    const parent = scopedIssue(
      rawParent,
      repo,
      repository,
      parentTicket,
      "Parent Ticket",
    );
    scope = await readParentObservation(read, parent, rawParent);
  }
  return {
    issue: {
      ...issue,
      title,
      body,
      source: url,
      ...(await readIssueMarkers(client, issue.id, target, signal)),
      blockers: await readIssueConnection(
        read,
        issue.id,
        "blockedBy",
        issueFields,
        parseIssuePage(target.blockedBy, issue.id, "blockedBy", parseIssueFact),
        parseIssueFact,
      ),
    },
    ...lookup,
    ...(scope ? { scope } : {}),
  };
}

export async function readViewer(
  client: GitHubClient,
  signal?: AbortSignal,
): Promise<ViewerIdentity> {
  const data = await requestIssueGraphQL(
    client,
    `query Viewer { viewer { __typename id login } }`,
    {},
    signal,
  );
  return parseViewer(data.viewer);
}
