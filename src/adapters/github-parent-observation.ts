import type { Ticket } from "../run/contracts.ts";
import type { GitHubClient } from "./github-client.ts";

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("GitHub returned incomplete Issue facts");
  return value as RecordValue;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("GitHub returned incomplete Issue identity");
  return value;
}
const identity = "id number state stateReason repository { id nameWithOwner }";
const pageInfo = "pageInfo { hasNextPage endCursor }";
const nested = `labels(first:100) { nodes { id name } ${pageInfo} }
 assignees(first:100) { nodes { id login } ${pageInfo} }
 blockedBy(first:100) { nodes { ${identity} } ${pageInfo} }`;
const children = `subIssues(first:100) { nodes { ${identity} ${nested} } ${pageInfo} }`;

export function parseIssueFact(value: unknown): Ticket & { id: string } {
  const node = object(value);
  const repo = object(node.repository);
  text(repo.id);
  const number = node.number;
  if (!Number.isSafeInteger(number) || (number as number) <= 0)
    throw new Error("GitHub returned invalid Issue number");
  if (node.state !== "OPEN" && node.state !== "CLOSED")
    throw new Error("GitHub returned unsupported Issue state");
  if (
    node.state === "CLOSED" &&
    node.stateReason !== "COMPLETED" &&
    node.stateReason !== "NOT_PLANNED"
  )
    throw new Error("GitHub returned unsupported Issue closure reason");
  return {
    id: text(node.id),
    number: number as number,
    repository: text(repo.nameWithOwner),
    repositoryId: text(repo.id),
    state: node.state === "OPEN" ? "open" : "closed",
    stateReason:
      node.state === "OPEN"
        ? null
        : node.stateReason === "COMPLETED"
          ? "completed"
          : "not_planned",
  };
}

export class ConnectionDrain {
  private readonly cursors = new Map<string, Set<string>>();
  readonly pending: { owner: string; field: string; cursor: string }[] = [];
  add(
    ownerId: string,
    field: string,
    value: unknown,
    accept: (node: unknown) => void,
  ) {
    const conn = object(value);
    if (!Array.isArray(conn.nodes))
      throw new Error("GitHub returned invalid connection nodes");
    conn.nodes.forEach(accept);
    const info = object(conn.pageInfo);
    if (
      typeof info.hasNextPage !== "boolean" ||
      (info.endCursor !== null && typeof info.endCursor !== "string")
    )
      throw new Error("GitHub returned invalid pagination");
    if (info.hasNextPage) {
      const cursor = text(info.endCursor);
      const key = `${ownerId}:${field}`;
      const seen = this.cursors.get(key) ?? new Set<string>();
      if (seen.has(cursor))
        throw new Error("GitHub returned non-advancing pagination");
      seen.add(cursor);
      this.cursors.set(key, seen);
      this.pending.push({ owner: ownerId, field, cursor });
    }
  }
}

export async function observeParent(
  client: GitHubClient,
  repository: string,
  number: number,
) {
  const [owner, name] = repository.split("/");
  const request = async (query: string, variables: RecordValue) => {
    const response = await client.graphql(query, variables);
    if (response.commandError || response.errors !== undefined)
      throw new Error("GitHub returned incomplete parent observation", {
        cause: response,
      });
    return object(response.data);
  };
  const data = await request(
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){id nameWithOwner issue(number:$number){${identity} ${children}}}}`,
    { owner, name, number },
  );
  const repo = object(data.repository);
  const repositoryId = text(repo.id);
  if (text(repo.nameWithOwner) !== repository)
    throw new Error("Unexpected repository identity");
  const root = object(repo.issue);
  if (text(object(root.repository).id) !== repositoryId)
    throw new Error("Unexpected parent repository identity");
  const parent = parseIssueFact(root);
  if (parent.number !== number || parent.repository !== repository)
    throw new Error("Unexpected parent identity");
  const tickets = new Map<
    string,
    Ticket & { id: string; blockers: Ticket[] }
  >();
  const drain = new ConnectionDrain();
  const identities = new Map<string, Set<string>>();
  function acceptChild(value: unknown) {
    const node = object(value);
    const parsed = parseIssueFact(node);
    if (
      parsed.repository === repository &&
      text(object(node.repository).id) !== repositoryId
    )
      throw new Error("Unexpected child repository identity");
    if (parsed.repository !== repository)
      throw new Error(
        `cross-repository child ${parsed.repository}#${parsed.number} is unsupported`,
      );
    let ticket = tickets.get(parsed.id);
    if (ticket) {
      if (
        ticket.number !== parsed.number ||
        ticket.repository !== parsed.repository ||
        ticket.state !== parsed.state ||
        ticket.stateReason !== parsed.stateReason
      )
        throw new Error("GitHub returned inconsistent child identity");
      return;
    }
    ticket = {
      ...parsed,
      labels: [],
      assignees: [],
      labelIds: Object.create(null) as Record<string, string>,
      assigneeIds: Object.create(null) as Record<string, string>,
      blockers: [],
    };
    tickets.set(parsed.id, ticket);
    for (const field of ["labels", "assignees", "blockedBy"])
      acceptConnection(parsed.id, field, node[field]);
  }
  function acceptConnection(id: string, field: string, value: unknown) {
    const ticket = tickets.get(id);
    if (!ticket) throw new Error("GitHub returned unknown connection owner");
    const key = `${id}:${field}`;
    const seen = identities.get(key) ?? new Set<string>();
    identities.set(key, seen);
    drain.add(id, field, value, (value) => {
      const node = object(value);
      const nodeId = text(node.id);
      if (seen.has(nodeId)) return;
      seen.add(nodeId);
      if (field === "labels") {
        const name = text(node.name);
        ticket.labels!.push(name);
        ticket.labelIds![name] = nodeId;
      } else if (field === "assignees") {
        const login = text(node.login);
        ticket.assignees!.push(login);
        ticket.assigneeIds![login] = nodeId;
      } else ticket.blockers.push(parseIssueFact(node));
    });
  }
  drain.add(parent.id, "subIssues", root.subIssues, acceptChild);
  while (drain.pending.length) {
    const next = drain.pending.shift()!;
    const selection =
      next.field === "subIssues"
        ? `${identity} ${nested}`
        : next.field === "labels"
          ? "id name"
          : next.field === "assignees"
            ? "id login"
            : identity;
    const result = await request(
      `query($id:ID!,$after:String!){node(id:$id){... on Issue { id ${next.field}(first:100,after:$after){nodes{${selection}} ${pageInfo}}}}}`,
      { id: next.owner, after: next.cursor },
    );
    const node = object(result.node);
    if (text(node.id) !== next.owner)
      throw new Error("GitHub returned mismatched connection owner");
    if (next.field === "subIssues")
      drain.add(parent.id, next.field, node[next.field], acceptChild);
    else acceptConnection(next.owner, next.field, node[next.field]);
  }
  return { parent, tickets: [...tickets.values()] };
}
