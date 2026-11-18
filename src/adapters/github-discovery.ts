import type { Ticket } from "../run/contracts.ts";
import { GitHubClient } from "./github-client.ts";

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("GitHub returned an invalid discovery fact");
  return value as RecordValue;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("GitHub returned a missing discovery identity");
  return value;
}
export function parseIssueFact(
  value: unknown,
): Ticket & { id: string; repository: string; repositoryId: string } {
  const node = object(value);
  const repo = object(node.repository);
  const repositoryId = string(repo.id);
  const repository = string(repo.nameWithOwner);
  if (!Number.isSafeInteger(node.number) || (node.number as number) < 1)
    throw new Error("GitHub returned an invalid issue number");
  if (node.state !== "OPEN" && node.state !== "CLOSED")
    throw new Error("GitHub returned an unsupported issue state");
  if (
    node.state === "OPEN" &&
    node.stateReason !== null &&
    node.stateReason !== "REOPENED"
  )
    throw new Error("GitHub issue has an unsupported state reason");
  if (
    node.state === "CLOSED" &&
    node.stateReason !== "COMPLETED" &&
    node.stateReason !== "NOT_PLANNED"
  )
    throw new Error("GitHub issue has an unsupported terminal state");
  return {
    id: string(node.id),
    number: node.number as number,
    repository,
    repositoryId,
    state: node.state === "OPEN" ? "open" : "closed",
    stateReason:
      node.state === "OPEN"
        ? null
        : node.stateReason === "COMPLETED"
          ? "completed"
          : "not_planned",
  };
}
const identity = `id number state stateReason repository { id nameWithOwner }`;
const connection = `pageInfo { hasNextPage endCursor } nodes`;
const childFacts = `${identity}
 labels(first:100) { ${connection} { id name } }
 assignees(first:100) { ${connection} { id login } }
 blockedBy(first:100) { ${connection} { ${identity} } }`;

export function parseConnectionPage(value: unknown): {
  nodes: unknown[];
  cursor: string | null;
} {
  const page = object(value);
  const info = object(page.pageInfo);
  if (!Array.isArray(page.nodes) || typeof info.hasNextPage !== "boolean")
    throw new Error("GitHub returned an invalid connection");
  if (
    info.endCursor !== null &&
    (typeof info.endCursor !== "string" || !info.endCursor.trim())
  )
    throw new Error("GitHub returned an invalid cursor");
  if (info.hasNextPage && !info.endCursor)
    throw new Error("GitHub returned a missing cursor");
  return {
    nodes: page.nodes,
    cursor: info.hasNextPage ? string(info.endCursor) : null,
  };
}

type ConnectionName = "subIssues" | "labels" | "assignees" | "blockedBy";
interface Pending {
  owner: string;
  name: ConnectionName;
  cursor: string;
  seen: Set<string>;
}

export async function discoverParent(
  client: GitHubClient,
  repository: string,
  number: number,
  runner: string,
  reservation: string,
  includeChildren = true,
  completion?: { parentId?: string },
): Promise<{
  parent: Ticket;
  tickets: Ticket[];
  reservationId: string | null;
  runnerId: string | null;
}> {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !part))
    throw new Error("Invalid repository identity");
  const issueFields = completion ? identity : childFacts;
  const children = `subIssues(first:100) { ${connection} { ${issueFields} } }`;
  const query = completion
    ? completion.parentId
      ? `mutation CloseParent($id:ID!) { closeIssue(input:{issueId:$id,stateReason:COMPLETED}) { issue { ${identity} ${children} } } }`
      : `query ParentCompletion($owner:String!,$name:String!,$number:Int!) { repository(owner:$owner,name:$name) { id nameWithOwner issue(number:$number) { ${identity} ${children} } } }`
    : `query Discovery($owner:String!,$name:String!,$number:Int!,$runner:String!,$reservation:String!) {
    repository(owner:$owner,name:$name) { id nameWithOwner label(name:$reservation) { id name }
      issue(number:$number) { ${childFacts} ${includeChildren ? children : ""} }
    } user(login:$runner) { id login }
  }`;
  const response = await client.graphql(
    query,
    completion?.parentId
      ? { id: completion.parentId }
      : completion
        ? { owner: parts[0], name: parts[1], number }
        : { owner: parts[0], name: parts[1], number, runner, reservation },
  );
  if (Array.isArray(response.errors) && response.errors.length)
    throw new Error("GitHub discovery returned GraphQL errors");
  const data = object(response.data);
  const rawParent = completion?.parentId
    ? object(object(data.closeIssue).issue)
    : object(object(data.repository).issue);
  const repo = completion?.parentId
    ? object(rawParent.repository)
    : object(data.repository);
  const repositoryId = string(repo.id);
  if (string(repo.nameWithOwner).toLowerCase() !== repository.toLowerCase())
    throw new Error("Unexpected repository identity");
  const label = completion || repo.label === null ? null : object(repo.label);
  if (label) {
    string(label.id);
    if (label.name !== reservation)
      throw new Error("Unexpected reservation label");
  }
  const user = completion || data.user === null ? null : object(data.user);
  if (user) {
    string(user.id);
    if (
      typeof user.login !== "string" ||
      user.login.toLowerCase() !== runner.toLowerCase()
    )
      throw new Error("Unexpected runner account");
  }
  const parent = parseIssueFact(rawParent);
  if (
    parent.repository.toLowerCase() !== repository.toLowerCase() ||
    parent.repositoryId !== repositoryId ||
    parent.number !== number ||
    (completion?.parentId !== undefined && parent.id !== completion.parentId)
  )
    throw new Error("Unexpected parent identity");
  const tickets = new Map<string, Ticket>();
  const pending: Pending[] = [];
  const identities = new Map<string, string>();
  const seenNodes = new Map<string, Map<string, string>>();
  const addPage = (
    owner: string,
    name: ConnectionName,
    value: unknown,
    seen = new Set<string>(),
  ) => {
    const page = parseConnectionPage(value);
    if (page.cursor !== null) {
      if (seen.has(page.cursor))
        throw new Error("GitHub returned non-advancing pagination");
      seen.add(page.cursor);
      pending.push({ owner, name, cursor: page.cursor, seen });
    }
    const key = JSON.stringify([owner, name]);
    const nodes = seenNodes.get(key) ?? new Map<string, string>();
    seenNodes.set(key, nodes);
    for (const raw of page.nodes) {
      const node = object(raw);
      const id = string(node.id);
      const fingerprint = JSON.stringify(node);
      if (nodes.has(id)) {
        if (nodes.get(id) !== fingerprint)
          throw new Error("Conflicting connection identity");
        continue;
      }
      nodes.set(id, fingerprint);
      if (name === "subIssues") {
        const child = parseIssueFact(node);
        if (
          child.repository.toLowerCase() !== repository.toLowerCase() ||
          child.repositoryId !== repositoryId
        )
          throw new Error(
            `cross-repository child ${child.repository}#${child.number} is unsupported`,
          );
        const key = `${child.repository.toLowerCase()}#${child.number}`;
        if (identities.has(key) && identities.get(key) !== id)
          throw new Error("Conflicting child identity");
        identities.set(key, id);
        if (tickets.has(id)) continue;
        tickets.set(id, child);
        if (completion) continue;
        child.labels = [];
        child.assignees = [];
        child.blockers = [];
        child.labelIds = Object.create(null) as Record<string, string>;
        child.assigneeIds = Object.create(null) as Record<string, string>;
        addPage(id, "labels", node.labels);
        addPage(id, "assignees", node.assignees);
        addPage(id, "blockedBy", node.blockedBy);
      } else {
        const child = owner === parent.id ? parent : tickets.get(owner);
        if (!child) throw new Error("Missing connection owner");
        if (name === "blockedBy") {
          const blocker = parseIssueFact(node);
          if (!child.blockers!.some((item) => item.id === blocker.id))
            child.blockers!.push(blocker);
        } else {
          const field = name === "labels" ? "name" : "login";
          const value = string(node[field]);
          const list = child[name]!;
          const ids = name === "labels" ? child.labelIds! : child.assigneeIds!;
          if (ids[value] !== undefined && ids[value] !== id)
            throw new Error("Conflicting connection identity");
          if (!Object.values(ids).includes(id)) {
            ids[value] = id;
            list.push(value);
          }
        }
      }
    }
  };
  if (!completion) {
    parent.labels = [];
    parent.assignees = [];
    parent.blockers = [];
    parent.labelIds = Object.create(null) as Record<string, string>;
    parent.assigneeIds = Object.create(null) as Record<string, string>;
    addPage(parent.id, "labels", rawParent.labels);
    addPage(parent.id, "assignees", rawParent.assignees);
    addPage(parent.id, "blockedBy", rawParent.blockedBy);
  }
  if (includeChildren) addPage(parent.id, "subIssues", rawParent.subIssues);
  while (pending.length) {
    const next = pending.shift()!;
    const fields =
      next.name === "subIssues"
        ? issueFields
        : next.name === "blockedBy"
          ? identity
          : next.name === "labels"
            ? "id name"
            : "id login";
    const continuation = `query More($id:ID!,$after:String!) { node(id:$id) { ... on Issue { id ${next.name}(first:100,after:$after) { ${connection} { ${fields} } } } } }`;
    const page = await client.graphql(continuation, {
      id: next.owner,
      after: next.cursor,
    });
    if (Array.isArray(page.errors) && page.errors.length)
      throw new Error("GitHub discovery returned GraphQL errors");
    const owner = object(object(page.data).node);
    if (owner.id !== next.owner) throw new Error("Unexpected connection owner");
    addPage(next.owner, next.name, owner[next.name], next.seen);
  }
  return {
    parent,
    tickets: [...tickets.values()],
    reservationId: label ? string(label.id) : null,
    runnerId: user ? string(user.id) : null,
  };
}
