import type { Ticket } from "../run/contracts.ts";
import type { GitHubClient } from "./github-client.ts";
import {
  ConnectionDrain,
  parseIssueFact,
} from "./github-parent-observation.ts";

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("GitHub returned incomplete start facts");
  return value as RecordValue;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("GitHub returned incomplete start identity");
  return value;
}
const identity = "id number state stateReason repository { id nameWithOwner }";
const pageInfo = "pageInfo { hasNextPage endCursor }";
const markers = `labels(first:100){nodes{id name} ${pageInfo}} assignees(first:100){nodes{id login} ${pageInfo}}`;
const facts = `${identity} title body url ${markers} blockedBy(first:100){nodes{${identity}} ${pageInfo}}`;
export interface StartInput {
  repository: string;
  number: number;
  parent?: number;
  runner: string;
  label: string;
}
export interface StartObservation {
  ticket: Ticket & { id: string };
  parent?: Ticket;
  children?: Ticket[];
  labelId?: string;
  runnerId?: string;
}

async function request(
  client: GitHubClient,
  query: string,
  variables: RecordValue,
): Promise<RecordValue> {
  const response = await client.graphql(query, variables);
  if (response.commandError || response.errors !== undefined)
    throw new Error("GitHub returned incomplete start response", {
      cause: response,
    });
  return object(response.data);
}
async function drainTicket(
  client: GitHubClient,
  root: RecordValue,
  ticket: Ticket & { id: string },
  includeBlockers: boolean,
) {
  ticket.labels = [];
  ticket.assignees = [];
  ticket.blockers = [];
  ticket.labelIds = Object.create(null) as Record<string, string>;
  ticket.assigneeIds = Object.create(null) as Record<string, string>;
  const drain = new ConnectionDrain();
  const seen = new Map<string, Set<string>>();
  const add = (field: string, value: unknown) =>
    drain.add(ticket.id, field, value, (item) => {
      const node = object(item);
      const id = text(node.id);
      const ids = seen.get(field) ?? new Set<string>();
      if (ids.has(id)) return;
      ids.add(id);
      seen.set(field, ids);
      if (field === "labels") {
        const name = text(node.name);
        ticket.labels!.push(name);
        ticket.labelIds![name] = id;
      } else if (field === "assignees") {
        const login = text(node.login);
        ticket.assignees!.push(login);
        ticket.assigneeIds![login] = id;
      } else ticket.blockers!.push(parseIssueFact(node));
    });
  for (const field of includeBlockers
    ? ["labels", "assignees", "blockedBy"]
    : ["labels", "assignees"])
    add(field, root[field]);
  while (drain.pending.length) {
    const next = drain.pending.shift()!;
    const selection =
      next.field === "labels"
        ? "id name"
        : next.field === "assignees"
          ? "id login"
          : identity;
    const data = await request(
      client,
      `query($id:ID!,$after:String!){node(id:$id){... on Issue{id ${next.field}(first:100,after:$after){nodes{${selection}} ${pageInfo}}}}}`,
      { id: ticket.id, after: next.cursor },
    );
    const node = object(data.node);
    if (text(node.id) !== ticket.id)
      throw new Error("GitHub returned mismatched connection owner");
    add(next.field, node[next.field]);
  }
}
function validateIdentity(
  ticket: Ticket,
  repository: string,
  number: number,
  repositoryId: string,
) {
  if (
    ticket.number !== number ||
    ticket.repository?.toLowerCase() !== repository.toLowerCase() ||
    ticket.repositoryId !== repositoryId
  )
    throw new Error("Unexpected Issue ownership");
}
export async function observeDelivery(
  client: GitHubClient,
  repository: string,
  number: number,
): Promise<Ticket> {
  const [owner, name] = repository.split("/");
  const data = await request(
    client,
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){id nameWithOwner issue(number:$number){${identity} labels(first:100){nodes{id name} ${pageInfo}}}}}`,
    { owner, name, number },
  );
  const repo = object(data.repository);
  const repositoryId = text(repo.id);
  if (text(repo.nameWithOwner).toLowerCase() !== repository.toLowerCase())
    throw new Error("Unexpected repository identity");
  const root = object(repo.issue);
  const ticket = parseIssueFact(root);
  validateIdentity(ticket, repository, number, repositoryId);
  ticket.labels = [];
  const drain = new ConnectionDrain();
  const add = (value: unknown) =>
    drain.add(ticket.id, "labels", value, (item) => {
      const label = object(item);
      text(label.id);
      ticket.labels!.push(text(label.name));
    });
  add(root.labels);
  while (drain.pending.length) {
    const next = drain.pending.shift()!;
    const page = await request(
      client,
      `query($id:ID!,$after:String!){node(id:$id){... on Issue{id labels(first:100,after:$after){nodes{id name} ${pageInfo}}}}}`,
      { id: ticket.id, after: next.cursor },
    );
    const node = object(page.node);
    if (text(node.id) !== ticket.id)
      throw new Error("GitHub returned mismatched connection owner");
    add(node.labels);
  }
  return ticket;
}

export async function observeStart(
  client: GitHubClient,
  input: StartInput,
): Promise<StartObservation> {
  const [owner, name] = input.repository.split("/");
  const scoped = input.parent !== undefined;
  const data = await request(
    client,
    `query($owner:String!,$name:String!,$number:Int!,$runner:String!,$label:String!${scoped ? ",$parent:Int!" : ""}){repository(owner:$owner,name:$name){id nameWithOwner label(name:$label){id name} target:issue(number:$number){${facts}} ${scoped ? `parent:issue(number:$parent){${identity} subIssues(first:100){nodes{${identity}} ${pageInfo}}}` : ""}} user(login:$runner){id login}}`,
    {
      owner,
      name,
      number: input.number,
      runner: input.runner,
      label: input.label,
      ...(scoped ? { parent: input.parent } : {}),
    },
  );
  const repo = object(data.repository);
  const repositoryId = text(repo.id);
  if (text(repo.nameWithOwner).toLowerCase() !== input.repository.toLowerCase())
    throw new Error("Unexpected repository identity");
  const label = repo.label === null ? undefined : object(repo.label);
  const runner = data.user === null ? undefined : object(data.user);
  if (
    (label && text(label.name) !== input.label) ||
    (runner && text(runner.login).toLowerCase() !== input.runner.toLowerCase())
  )
    throw new Error("Unexpected marker identity");
  const markerIds = {
    ...(label ? { labelId: text(label.id) } : {}),
    ...(runner ? { runnerId: text(runner.id) } : {}),
  };
  const root = object(repo.target);
  const ticket = parseIssueFact(root);
  validateIdentity(ticket, input.repository, input.number, repositoryId);
  if (
    typeof root.title !== "string" ||
    typeof root.body !== "string" ||
    typeof root.url !== "string"
  )
    throw new Error("GitHub returned incomplete Issue snapshot");
  ticket.title = root.title;
  ticket.body = root.body;
  ticket.source = root.url;
  await drainTicket(client, root, ticket, true);
  if (!scoped) return { ticket, ...markerIds };
  const parentNode = object(repo.parent);
  const parent = parseIssueFact(parentNode);
  validateIdentity(parent, input.repository, input.parent!, repositoryId);
  const children: Ticket[] = [];
  const seen = new Set<string>();
  const drain = new ConnectionDrain();
  const add = (value: unknown) =>
    drain.add(parent.id, "subIssues", value, (item) => {
      const child = parseIssueFact(item);
      validateIdentity(child, input.repository, child.number, repositoryId);
      if (!seen.has(child.id)) {
        seen.add(child.id);
        children.push(child);
      }
    });
  add(parentNode.subIssues);
  while (drain.pending.length) {
    const next = drain.pending.shift()!;
    const result = await request(
      client,
      `query($id:ID!,$after:String!){node(id:$id){... on Issue{id subIssues(first:100,after:$after){nodes{${identity}} ${pageInfo}}}}}`,
      { id: parent.id, after: next.cursor },
    );
    const node = object(result.node);
    if (text(node.id) !== parent.id)
      throw new Error("GitHub returned mismatched parent");
    add(node.subIssues);
  }
  return {
    ticket,
    parent,
    children,
    ...markerIds,
  };
}
export async function reserveStart(
  client: GitHubClient,
  input: {
    ticket: Ticket & { id: string };
    labelId?: string;
    runnerId?: string;
    label: string;
    runner: string;
  },
): Promise<Ticket> {
  const label = input.labelId !== undefined;
  const runner = input.runnerId !== undefined;
  const fields = `${label ? `addReservation:addLabelsToLabelable(input:{labelableId:$issue,labelIds:[$label]}){labelable{... on Issue{${identity} ${markers}}}}` : ""} ${runner ? `addRunner:addAssigneesToAssignable(input:{assignableId:$issue,assigneeIds:[$runner]}){assignable{... on Issue{${identity} ${markers}}}}` : ""}`;
  const data = await request(
    client,
    `mutation($issue:ID!${label ? ",$label:ID!" : ""}${runner ? ",$runner:ID!" : ""}){${fields}}`,
    {
      issue: input.ticket.id,
      ...(label ? { label: input.labelId } : {}),
      ...(runner ? { runner: input.runnerId } : {}),
    },
  );
  if (label) {
    const first = parseIssueFact(object(object(data.addReservation).labelable));
    validateIdentity(
      first,
      input.ticket.repository!,
      input.ticket.number,
      input.ticket.repositoryId!,
    );
    if (first.id !== input.ticket.id || first.state !== "open")
      throw new Error("GitHub returned mismatched Reservation");
  }
  const root = object(
    runner
      ? object(data.addRunner).assignable
      : object(data.addReservation).labelable,
  );
  const ticket = parseIssueFact(root);
  validateIdentity(
    ticket,
    input.ticket.repository!,
    input.ticket.number,
    input.ticket.repositoryId!,
  );
  if (ticket.id !== input.ticket.id || ticket.state !== "open")
    throw new Error("GitHub returned mismatched Reservation");
  await drainTicket(client, root, ticket, false);
  if (
    !ticket.labels!.includes(input.label) ||
    !ticket.assignees!.includes(input.runner) ||
    ticket.assignees!.some((account) => account !== input.runner)
  )
    throw new Error("GitHub did not confirm Reservation");
  return ticket;
}
