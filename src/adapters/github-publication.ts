import type { GitHubClient } from "./github-client.ts";
import type {
  PublicationObservation,
  PublicationPullRequest,
} from "../run/contracts.ts";

const fields = `id number url headRefName baseRefName headRefOid state isDraft createdAt
  headRepository { nameWithOwner } baseRepository { id nameWithOwner }`;
const sha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

type Row = Record<string, unknown>;
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("GitHub returned invalid publication data");
  return value as Row;
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function parseRepository(value: unknown, repository: string): Row {
  const row = object(value);
  if (
    !nonempty(row.id) ||
    !nonempty(row.nameWithOwner) ||
    row.nameWithOwner.toLowerCase() !== repository.toLowerCase()
  )
    throw new Error("GitHub returned invalid publication repository");
  return row;
}
function parseRef(value: unknown): string | null {
  if (value === null) return null;
  const target = object(object(value).target);
  if (typeof target.oid !== "string" || !sha.test(target.oid))
    throw new Error("GitHub returned invalid publication branch");
  return target.oid;
}
function parsePullRequest(
  value: unknown,
  repository: string,
  repositoryId: string,
): PublicationPullRequest | undefined {
  const row = object(value);
  const base = parseRepository(row.baseRepository, repository);
  if (base.id !== repositoryId)
    throw new Error("GitHub returned inconsistent publication repository");
  if (
    !nonempty(row.id) ||
    !Number.isSafeInteger(row.number) ||
    (row.number as number) <= 0 ||
    !nonempty(row.url) ||
    !nonempty(row.headRefName) ||
    !nonempty(row.baseRefName) ||
    typeof row.headRefOid !== "string" ||
    !sha.test(row.headRefOid) ||
    !["OPEN", "CLOSED", "MERGED"].includes(String(row.state)) ||
    typeof row.isDraft !== "boolean" ||
    !nonempty(row.createdAt) ||
    !Number.isFinite(Date.parse(row.createdAt))
  )
    throw new Error("GitHub returned invalid publication Pull Request");
  const prefix = `https://github.com/${repository}/pull/`;
  if (row.url.toLowerCase() !== `${prefix}${String(row.number)}`.toLowerCase())
    throw new Error("GitHub returned invalid Pull Request URL");
  if (row.headRepository === null) return undefined;
  const head = object(row.headRepository);
  if (!nonempty(head.nameWithOwner))
    throw new Error("GitHub returned invalid head repository");
  if (head.nameWithOwner.toLowerCase() !== repository.toLowerCase())
    return undefined;
  return {
    id: row.id,
    number: row.number as number,
    url: row.url,
    branch: row.headRefName,
    targetBranch: row.baseRefName,
    headSha: row.headRefOid,
    state: String(row.state).toLowerCase() as PublicationPullRequest["state"],
    draft: row.isDraft,
    createdAt: row.createdAt,
  };
}
async function query(
  client: GitHubClient,
  text: string,
  variables: Record<string, unknown>,
): Promise<Row> {
  const response = await client.graphql(text, variables);
  if (response.commandError || response.errors !== undefined)
    throw new Error("GitHub returned incomplete publication data", {
      cause: response,
    });
  return object(response.data);
}
export async function observePublicationBranch(
  client: GitHubClient,
  repository: string,
  branch: string,
) {
  const [owner, name] = repository.split("/");
  const data = await query(
    client,
    `query($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){id nameWithOwner ref(qualifiedName:$ref){target{oid}}}}`,
    { owner, name, ref: `refs/heads/${branch}` },
  );
  const repo = parseRepository(data.repository, repository);
  return { repositoryId: repo.id as string, head: parseRef(repo.ref) };
}
export async function observePublication(
  client: GitHubClient,
  input: { repository: string; branch: string; targetBranch: string },
): Promise<PublicationObservation> {
  const [owner, name] = input.repository.split("/");
  let sourceAfter: string | null = null,
    targetAfter: string | null = null;
  let sourceMore = true,
    targetMore = true;
  let repositoryId: string | undefined, head: string | null | undefined;
  const candidates = new Map<string, PublicationPullRequest>();
  const totals: { source?: number; target?: number } = {},
    counts = { source: 0, target: 0 };
  const seen = { source: new Set<string>(), target: new Set<string>() };
  const cursors = { source: new Set<string>(), target: new Set<string>() };
  while (sourceMore || targetMore) {
    const data = await query(
      client,
      `query($owner:String!,$name:String!,$ref:String!,$branch:String!,$base:String!,$sourceAfter:String,$targetAfter:String,$sourceMore:Boolean!,$targetMore:Boolean!){repository(owner:$owner,name:$name){id nameWithOwner ref(qualifiedName:$ref){target{oid}} source:pullRequests(first:100,after:$sourceAfter,headRefName:$branch,states:[OPEN,CLOSED,MERGED]) @include(if:$sourceMore){totalCount nodes{${fields}} pageInfo{hasNextPage endCursor}} target:pullRequests(first:100,after:$targetAfter,baseRefName:$base,states:[OPEN,CLOSED,MERGED]) @include(if:$targetMore){totalCount nodes{${fields}} pageInfo{hasNextPage endCursor}}}}`,
      {
        owner,
        name,
        ref: `refs/heads/${input.branch}`,
        branch: input.branch,
        base: input.targetBranch,
        sourceAfter,
        targetAfter,
        sourceMore,
        targetMore,
      },
    );
    const repo = parseRepository(data.repository, input.repository);
    const currentHead = parseRef(repo.ref);
    if (
      repositoryId !== undefined &&
      (repositoryId !== repo.id || head !== currentHead)
    )
      throw new Error("Publication changed during pagination");
    repositoryId = repo.id as string;
    head = currentHead;
    for (const key of ["source", "target"] as const) {
      if (!(key === "source" ? sourceMore : targetMore)) continue;
      const connection = object(repo[key]);
      const page = object(connection.pageInfo);
      if (
        !Array.isArray(connection.nodes) ||
        !Number.isSafeInteger(connection.totalCount) ||
        (connection.totalCount as number) < 0 ||
        typeof page.hasNextPage !== "boolean" ||
        (page.endCursor !== null && typeof page.endCursor !== "string")
      )
        throw new Error("GitHub returned incomplete publication candidates");
      if (totals[key] !== undefined && totals[key] !== connection.totalCount)
        throw new Error("Publication candidates changed during pagination");
      totals[key] = connection.totalCount as number;
      for (const node of connection.nodes) {
        const raw = object(node);
        if (
          (key === "source" && raw.headRefName !== input.branch) ||
          (key === "target" && raw.baseRefName !== input.targetBranch)
        )
          throw new Error(
            "GitHub returned publication candidates outside the requested connection",
          );
        if (!nonempty(raw.id) || seen[key].has(raw.id))
          throw new Error("GitHub returned duplicate publication candidates");
        seen[key].add(raw.id);
        counts[key]++;
        const candidate = parsePullRequest(
          node,
          input.repository,
          repositoryId,
        );
        if (candidate) {
          const previous = candidates.get(candidate.id);
          if (
            previous &&
            JSON.stringify(previous) !== JSON.stringify(candidate)
          )
            throw new Error("Publication candidate changed during pagination");
          candidates.set(candidate.id, candidate);
        }
      }
      if (page.hasNextPage) {
        if (
          !nonempty(page.endCursor) ||
          cursors[key].has(page.endCursor) ||
          connection.nodes.length === 0 ||
          counts[key] >= totals[key]
        )
          throw new Error("GitHub returned invalid publication cursor");
        cursors[key].add(page.endCursor);
      }
      if (!page.hasNextPage && counts[key] !== totals[key])
        throw new Error("GitHub returned truncated publication candidates");
      if (key === "source") {
        sourceMore = page.hasNextPage;
        sourceAfter = page.endCursor;
      } else {
        targetMore = page.hasNextPage;
        targetAfter = page.endCursor;
      }
    }
  }
  return {
    repositoryId: repositoryId!,
    head: head!,
    candidates: [...candidates.values()],
  };
}
export async function createPublication(
  client: GitHubClient,
  input: {
    repository: string;
    repositoryId: string;
    branch: string;
    targetBranch: string;
    title: string;
    body: string;
  },
): Promise<PublicationPullRequest> {
  const data = await query(
    client,
    `mutation($input:CreatePullRequestInput!){createPullRequest(input:$input){pullRequest{${fields}}}}`,
    {
      input: {
        repositoryId: input.repositoryId,
        headRefName: input.branch,
        baseRefName: input.targetBranch,
        title: input.title,
        body: input.body,
        draft: false,
        maintainerCanModify: true,
      },
    },
  );
  const pullRequest = parsePullRequest(
    object(data.createPullRequest).pullRequest,
    input.repository,
    input.repositoryId,
  );
  if (!pullRequest)
    throw new Error("GitHub returned a Pull Request from another repository");
  return pullRequest;
}
