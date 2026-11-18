import type { Ticket } from "../run/contracts.ts";
import { GitHubClient, GitHubGraphQLError } from "./github-client.ts";
import { parseConnectionPage, parseIssueFact } from "./github-discovery.ts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("GitHub returned an invalid reservation payload");
  return value as Record<string, unknown>;
}

export async function addReservation(
  client: GitHubClient,
  ticket: Ticket,
  label: { id: string; name: string } | undefined,
  runner: { id: string; login: string } | undefined,
  requiredLabel: string,
  requiredRunner: string,
): Promise<void> {
  const fields = `id number state stateReason repository { id nameWithOwner }
    labels(first:100) { pageInfo { hasNextPage endCursor } nodes { id name } }
    assignees(first:100) { pageInfo { hasNextPage endCursor } nodes { id login } }`;
  const query = `mutation Reserve($issue:ID!${label ? ",$label:ID!" : ""}${runner ? ",$runner:ID!" : ""}) {
    ${label ? `label:addLabelsToLabelable(input:{labelableId:$issue,labelIds:[$label]}) { labelable { ... on Issue { ${fields} } } }` : ""}
    ${runner ? `runner:addAssigneesToAssignable(input:{assignableId:$issue,assigneeIds:[$runner]}) { assignable { ... on Issue { ${fields} } } }` : ""}
  }`;
  const response = await client.graphql(query, {
    issue: ticket.id,
    ...(label ? { label: label.id } : {}),
    ...(runner ? { runner: runner.id } : {}),
  });
  if (Array.isArray(response.errors) && response.errors.length)
    throw new GitHubGraphQLError(
      "GitHub reservation returned GraphQL errors",
      response,
    );
  const data = object(response.data);
  for (const [alias, field] of [
    ...(label ? [["label", "labelable"]] : []),
    ...(runner ? [["runner", "assignable"]] : []),
  ]) {
    const issue = object(object(data[alias!])[field!]);
    const identity = parseIssueFact(issue);
    if (
      identity.id !== ticket.id ||
      identity.number !== ticket.number ||
      identity.state !== "open" ||
      identity.repositoryId !== ticket.repositoryId ||
      identity.repository.toLowerCase() !== ticket.repository?.toLowerCase()
    )
      throw new Error("Unexpected reservation identity");
  }
  const final = object(
    object(data[runner ? "runner" : "label"])[
      runner ? "assignable" : "labelable"
    ],
  );
  let externallyOwned = false;
  let missing = false;
  for (const [connection, key, expected] of [
    ["labels", "name", requiredLabel],
    ["assignees", "login", requiredRunner],
  ] as const) {
    const expectedId =
      connection === "labels"
        ? (label?.id ?? ticket.labelIds?.[expected])
        : (runner?.id ?? ticket.assigneeIds?.[expected]);
    if (!expectedId) throw new Error("Missing Reservation marker identity");
    let page = parseConnectionPage(final[connection]);
    const seen = new Set<string>();
    const markers = new Map<string, string>();
    const identities = new Map<string, string>();
    let found = false;
    for (;;) {
      for (const node of page.nodes) {
        const value = object(node);
        if (
          typeof value.id !== "string" ||
          !value.id ||
          typeof value[key] !== "string" ||
          !value[key]
        )
          throw new Error("Invalid reservation marker");
        const name = value[key];
        const id = value.id;
        if (
          (markers.has(name) && markers.get(name) !== id) ||
          (identities.has(id) && identities.get(id) !== name)
        )
          throw new Error("Conflicting Reservation marker identity");
        markers.set(name, id);
        identities.set(id, name);
        if (connection === "assignees" && value[key] !== expected)
          externallyOwned = true;
        if (value[key] === expected) {
          if (value.id !== expectedId)
            throw new Error("Unexpected Reservation marker identity");
          found = true;
        }
      }
      if (page.cursor === null) break;
      if (seen.has(page.cursor))
        throw new Error("GitHub returned non-advancing pagination");
      seen.add(page.cursor);
      const next = await client.graphql(
        `query More($id:ID!,$after:String!) { node(id:$id) { ... on Issue { id ${connection}(first:100,after:$after) { pageInfo { hasNextPage endCursor } nodes { id ${key} } } } } }`,
        { id: ticket.id, after: page.cursor },
      );
      if (Array.isArray(next.errors) && next.errors.length)
        throw new GitHubGraphQLError(
          "GitHub reservation returned GraphQL errors",
          next,
        );
      const owner = object(object(next.data).node);
      if (owner.id !== ticket.id)
        throw new Error("Unexpected reservation connection owner");
      page = parseConnectionPage(owner[connection]);
    }
    if (!found) missing = true;
  }
  if (externallyOwned) throw new Error("Reservation is externally owned");
  if (missing) throw new Error("Reservation marker not confirmed");
}
