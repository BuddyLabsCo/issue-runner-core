import type { BranchObservation, PullRequestRecord } from "../run/contracts.ts";
import { nonempty, object } from "../agent/handoff.ts";
import { oid } from "./github-pr-checks.ts";

export function sameRepository(value: unknown, expected: string): boolean {
  if (value === null) return false;
  const { nameWithOwner } = object(value);
  if (!nonempty(nameWithOwner))
    throw new Error("GitHub returned a repository without a name");
  return nameWithOwner.toLowerCase() === expected.toLowerCase();
}

export function parseBranch(
  remote: Record<string, unknown>,
  repository: string,
  branch: string,
): BranchObservation {
  if (!sameRepository(remote, repository) || !nonempty(remote.id))
    throw new Error("GitHub returned an unexpected publication repository");
  if (remote.ref === null) return { repositoryId: remote.id, headSha: null };
  const ref = object(remote.ref);
  const { oid: headSha } = object(ref.target);
  if (ref.name !== branch || typeof headSha !== "string" || !oid.test(headSha))
    throw new Error("GitHub returned invalid remote branch head");
  return { repositoryId: remote.id, headSha };
}

export function connectionPages() {
  return {
    after: null as string | null,
    total: undefined as number | undefined,
    done: false,
    cursors: new Set<string>(),
    ids: new Set<string>(),
  };
}

export function readConnectionPage(
  page: ReturnType<typeof connectionPages>,
  value: unknown,
  scope: string,
) {
  const { nodes, totalCount, pageInfo } = object(value);
  const { hasNextPage, endCursor } = object(pageInfo);
  if (
    !Array.isArray(nodes) ||
    nodes.length > 100 ||
    typeof totalCount !== "number" ||
    !Number.isSafeInteger(totalCount) ||
    totalCount < 0 ||
    (page.total !== undefined && page.total !== totalCount) ||
    typeof hasNextPage !== "boolean" ||
    (endCursor !== null && !nonempty(endCursor))
  )
    throw new Error(`GitHub returned invalid ${scope} pages`);
  const received = page.ids.size + nodes.length;
  if (hasNextPage ? received >= totalCount : received !== totalCount)
    throw new Error(`GitHub returned incomplete ${scope} pages`);
  page.total = totalCount;
  page.done = !hasNextPage;
  if (hasNextPage) {
    if (!nodes.length || !nonempty(endCursor) || page.cursors.has(endCursor))
      throw new Error(`GitHub returned an incomplete ${scope} cursor`);
    page.cursors.add(endCursor);
    page.after = endCursor;
  }
  return nodes.map((node: unknown) => {
    const row = object(node);
    if (!nonempty(row.id) || page.ids.has(row.id))
      throw new Error(
        `GitHub returned missing or repeated IDs in ${scope} pages`,
      );
    page.ids.add(row.id);
    return row;
  });
}

export function parsePullRequest(
  row: Record<string, unknown>,
  repository: string,
  repositoryId: string,
): PullRequestRecord {
  const {
    id,
    number,
    url,
    headRefName,
    baseRefName,
    headRefOid,
    state,
    isDraft,
    createdAt,
  } = row;
  if (
    !sameRepository(row.repository, repository) ||
    object(row.repository).id !== repositoryId ||
    !nonempty(id) ||
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    typeof url !== "string" ||
    url.toLowerCase() !==
      `https://github.com/${repository}/pull/${number}`.toLowerCase() ||
    !nonempty(headRefName) ||
    !nonempty(baseRefName) ||
    typeof headRefOid !== "string" ||
    !oid.test(headRefOid) ||
    (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") ||
    typeof isDraft !== "boolean" ||
    typeof createdAt !== "string" ||
    !Number.isFinite(Date.parse(createdAt))
  )
    throw new Error("GitHub returned invalid Pull Request identity");
  return {
    id,
    number,
    url,
    createdAt,
    branch: headRefName,
    targetBranch: baseRefName,
    headSha: headRefOid,
    draft: isDraft,
    state: state === "OPEN" ? "open" : state === "CLOSED" ? "closed" : "merged",
  };
}
