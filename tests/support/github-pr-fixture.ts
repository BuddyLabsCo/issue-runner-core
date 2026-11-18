const nameWithOwner = "Owner/Repo";
export const repository = { id: "R_repo", nameWithOwner };
export const createdAt = "2026-11-18T12:00:00Z";

export function connection(
  nodes: unknown[],
  totalCount = nodes.length,
  next: string | null = null,
) {
  return {
    nodes,
    totalCount,
    pageInfo: { hasNextPage: next !== null, endCursor: next },
  };
}

export const publication = {
  repository: "owner/repo",
  branch: "runner/issue",
  targetBranch: "main",
};
export const head = "a".repeat(40);
export const remote = {
  ...repository,
  ref: { name: publication.branch, target: { oid: head } },
};
export const exact = {
  id: "PR_exact",
  number: 81,
  url: "https://github.com/Owner/Repo/pull/81",
  headRefName: publication.branch,
  baseRefName: publication.targetBranch,
  headRefOid: head,
  repository,
  headRepository: repository,
  state: "OPEN",
  isDraft: false,
  createdAt,
};
