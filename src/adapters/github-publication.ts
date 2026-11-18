import type { PullRequestRecord } from "../run/contracts.ts";
import { GitHubClient } from "./github-client.ts";
import { parseConnectionPage } from "./github-discovery.ts";

const fields = `id number url headRefName baseRefName headRefOid headRepository { nameWithOwner } state isDraft createdAt`;
const connection = `nodes { ${fields} } pageInfo { hasNextPage endCursor } totalCount`;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("GitHub returned invalid publication evidence");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("GitHub returned invalid publication identity");
  return value;
}
function data(response: {
  data?: unknown;
  errors?: unknown;
}): Record<string, unknown> {
  if (
    response.errors !== undefined &&
    (!Array.isArray(response.errors) || response.errors.length)
  )
    throw new Error("GitHub publication returned GraphQL errors");
  return object(response.data);
}
function parseRepository(value: unknown, repository: string) {
  const repo = object(value);
  const id = string(repo.id);
  if (string(repo.nameWithOwner).toLowerCase() !== repository.toLowerCase())
    throw new Error("Unexpected publication repository");
  let head: string | null = null;
  if (repo.ref !== null) {
    const ref = object(repo.ref);
    head = string(object(ref.target).oid);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head))
      throw new Error("GitHub returned invalid remote branch head");
  }
  return { repositoryId: id, head };
}
function parseCandidate(
  value: unknown,
  repository: string,
): PullRequestRecord | undefined {
  const node = object(value);
  const headRepository =
    node.headRepository === null
      ? ""
      : string(object(node.headRepository).nameWithOwner);
  const id = string(node.id);
  const url = string(node.url);
  const createdAt = string(node.createdAt);
  const branch = string(node.headRefName);
  const targetBranch = string(node.baseRefName);
  const headSha = string(node.headRefOid);
  if (
    !Number.isSafeInteger(node.number) ||
    (node.number as number) < 1 ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(headSha) ||
    !Number.isFinite(Date.parse(createdAt)) ||
    typeof node.isDraft !== "boolean" ||
    !["OPEN", "CLOSED", "MERGED"].includes(String(node.state))
  )
    throw new Error("GitHub returned invalid Pull Request");
  const prefix = `https://github.com/${repository}/pull/${String(node.number)}`;
  if (url.toLowerCase() !== prefix.toLowerCase())
    throw new Error("GitHub returned invalid Pull Request identity");
  if (headRepository.toLowerCase() !== repository.toLowerCase())
    return undefined;
  return {
    id,
    number: node.number as number,
    url,
    createdAt,
    branch,
    targetBranch,
    headSha,
    draft: node.isDraft,
    state: String(node.state).toLowerCase() as PullRequestRecord["state"],
  };
}
export async function observeBranch(
  client: GitHubClient,
  repository: string,
  branch: string,
) {
  const [owner, name] = repository.split("/");
  const response = await client.graphql(
    `query PrePush($owner:String!,$name:String!,$ref:String!) { repository(owner:$owner,name:$name) { id nameWithOwner ref(qualifiedName:$ref) { target { oid } } } }`,
    { owner, name, ref: `refs/heads/${branch}` },
  );
  return parseRepository(data(response).repository, repository);
}
export async function observePublication(
  client: GitHubClient,
  repository: string,
  branch: string,
  targetBranch: string,
) {
  const [owner, name] = repository.split("/");
  const query = `query Publication($owner:String!,$name:String!,$ref:String!,$branch:String!,$base:String!,$headAfter:String,$baseAfter:String) { repository(owner:$owner,name:$name) { id nameWithOwner ref(qualifiedName:$ref) { target { oid } } source:pullRequests(first:100,after:$headAfter,headRefName:$branch,states:[OPEN,CLOSED,MERGED]) { ${connection} } target:pullRequests(first:100,after:$baseAfter,baseRefName:$base,states:[OPEN,CLOSED,MERGED]) { ${connection} } } }`;
  let headAfter: string | null = null,
    baseAfter: string | null = null;
  let sourceDone = false,
    targetDone = false;
  let initial: { repositoryId: string; head: string | null } | undefined;
  const seenCursors = [new Set<string>(), new Set<string>()];
  const candidates = new Map<string, PullRequestRecord>();
  const connectionIds = [new Set<string>(), new Set<string>()];
  const totals: (number | undefined)[] = [undefined, undefined];
  do {
    const response = await client.graphql(query, {
      owner,
      name,
      ref: `refs/heads/${branch}`,
      branch,
      base: targetBranch,
      headAfter,
      baseAfter,
    });
    const repo = object(data(response).repository);
    const observation = parseRepository(repo, repository);
    if (
      initial &&
      (initial.repositoryId !== observation.repositoryId ||
        initial.head !== observation.head)
    )
      throw new Error("Publication observation changed during pagination");
    initial = observation;
    for (const [index, key] of (["source", "target"] as const).entries()) {
      if (index === 0 ? sourceDone : targetDone) continue;
      const raw = object(repo[key]);
      const page = parseConnectionPage(raw);
      if (
        !Number.isSafeInteger(raw.totalCount) ||
        (raw.totalCount as number) < 0
      )
        throw new Error("GitHub returned invalid publication count");
      const total = raw.totalCount as number;
      if (totals[index] !== undefined && totals[index] !== total)
        throw new Error(
          "Publication candidate count changed during pagination",
        );
      totals[index] = total;
      for (const node of page.nodes) {
        const id = string(object(node).id);
        if (connectionIds[index]!.has(id))
          throw new Error("Duplicate Pull Request in connection");
        connectionIds[index]!.add(id);
        const candidate = parseCandidate(node, repository);
        if (!candidate) continue;
        const previous = candidates.get(candidate.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(candidate))
          throw new Error("Conflicting Pull Request identity");
        candidates.set(candidate.id, candidate);
      }
      if (!page.cursor && connectionIds[index]!.size !== total)
        throw new Error("Incomplete Pull Request connection");
      if (page.cursor && seenCursors[index]!.has(page.cursor))
        throw new Error("GitHub returned non-advancing pagination");
      if (page.cursor) seenCursors[index]!.add(page.cursor);
      if (index === 0) {
        headAfter = page.cursor;
        sourceDone = !page.cursor;
      } else {
        baseAfter = page.cursor;
        targetDone = !page.cursor;
      }
    }
  } while (!sourceDone || !targetDone);
  return { ...initial, candidates: [...candidates.values()] };
}
export async function createPublication(
  client: GitHubClient,
  input: {
    repository: string;
    repositoryId: string;
    targetBranch: string;
    branch: string;
    title: string;
    body: string;
  },
) {
  const response = await client.graphql(
    `mutation CreatePublication($input:CreatePullRequestInput!) { createPullRequest(input:$input) { pullRequest { ${fields} } } }`,
    {
      input: {
        repositoryId: input.repositoryId,
        baseRefName: input.targetBranch,
        headRefName: input.branch,
        title: input.title,
        body: input.body,
        draft: false,
        maintainerCanModify: true,
      },
    },
  );
  const candidate = parseCandidate(
    object(data(response).createPullRequest).pullRequest,
    input.repository,
  );
  if (!candidate) throw new Error("Unexpected Pull Request repository");
  return candidate;
}
