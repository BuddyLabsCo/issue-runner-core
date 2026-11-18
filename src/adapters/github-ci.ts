import type {
  PullRequestObservation,
  RequiredCheck,
} from "../run/contracts.ts";
import { GitHubClient } from "./github-client.ts";
import { parseConnectionPage } from "./github-discovery.ts";

const query = `query Poll($owner:String!,$name:String!,$number:Int!,$ref:String!,$after:String) {
  repository(owner:$owner,name:$name) { id nameWithOwner ref(qualifiedName:$ref) { target { oid } }
    pullRequest(number:$number) { id number url headRefName baseRefName headRefOid headRepository { nameWithOwner }
      state isDraft createdAt mergedAt mergeable mergeStateStatus isInMergeQueue isMergeQueueEnabled
      autoMergeRequest { enabledAt } mergeQueueEntry { id }
      commits(last:1) { nodes { commit { oid statusCheckRollup { contexts(first:100,after:$after) {
        totalCount pageInfo { hasNextPage endCursor } nodes { __typename
          ... on CheckRun { name status conclusion startedAt completedAt detailsUrl isRequired(pullRequestNumber:$number) checkSuite { workflowRun { event workflow { name } } } }
          ... on StatusContext { context state targetUrl createdAt isRequired(pullRequestNumber:$number) }
        }
      } } } } }
    }
  }
}`;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("GitHub returned incomplete CI observation");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("GitHub returned incomplete CI observation");
  return value;
}
function oid(value: unknown): string {
  const result = string(value);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(result))
    throw new Error("GitHub returned invalid CI head");
  return result;
}
function bucket(state: string): RequiredCheck["bucket"] {
  if (state === "SUCCESS") return "pass";
  if (["SKIPPED", "NEUTRAL"].includes(state)) return "skipping";
  if (["ERROR", "FAILURE", "TIMED_OUT", "ACTION_REQUIRED"].includes(state))
    return "fail";
  if (state === "CANCELLED") return "cancel";
  return "pending";
}
function project(value: unknown) {
  const node = object(value);
  const isRun = node.__typename === "CheckRun";
  if (!isRun && node.__typename !== "StatusContext")
    throw new Error("GitHub returned unknown check context");
  if (typeof node.isRequired !== "boolean")
    throw new Error("GitHub returned incomplete check context");
  const name = string(isRun ? node.name : node.context);
  const state = string(
    isRun && node.status === "COMPLETED"
      ? node.conclusion
      : isRun
        ? node.status
        : node.state,
  );
  const time = isRun ? node.startedAt : node.createdAt;
  if (
    time !== null &&
    (typeof time !== "string" || !Number.isFinite(Date.parse(time)))
  )
    throw new Error("GitHub returned invalid check time");
  const link = isRun ? node.detailsUrl : node.targetUrl;
  if (link !== null && typeof link !== "string")
    throw new Error("GitHub returned invalid check link");
  let key = `status:${name}`;
  if (isRun) {
    const suite = node.checkSuite === null ? null : object(node.checkSuite);
    const run =
      suite?.workflowRun === null || !suite ? null : object(suite.workflowRun);
    const workflow =
      run?.workflow === null || !run ? null : object(run.workflow);
    key = JSON.stringify([
      "run",
      name,
      workflow ? string(workflow.name) : "",
      run ? string(run.event) : "",
    ]);
  }
  return {
    key,
    time: time === null ? 0 : Date.parse(time),
    required: node.isRequired,
    check: {
      name,
      state,
      link: link ?? "",
      bucket: bucket(state),
    },
  };
}

export async function observePullRequest(
  client: GitHubClient,
  repository: string,
  branch: string,
  number: number,
): Promise<PullRequestObservation> {
  const [owner, name] = repository.split("/");
  for (;;) {
    let after: string | null = null;
    let initial: PullRequestObservation | undefined;
    let total: number | undefined;
    const cursors = new Set<string>();
    const contexts: ReturnType<typeof project>[] = [];
    let changed = false;
    do {
      const response = await client.graphql(query, {
        owner,
        name,
        number,
        ref: `refs/heads/${branch}`,
        after,
      });
      if (
        response.errors !== undefined &&
        (!Array.isArray(response.errors) || response.errors.length)
      )
        throw new Error("GitHub CI observation returned GraphQL errors");
      const repo = object(object(response.data).repository);
      if (string(repo.nameWithOwner).toLowerCase() !== repository.toLowerCase())
        throw new Error("Unexpected CI repository");
      const pr = object(repo.pullRequest);
      const commits = object(pr.commits).nodes;
      if (!Array.isArray(commits) || commits.length !== 1)
        throw new Error("GitHub returned no last Pull Request commit");
      const commit = object(object(commits[0]).commit);
      const state = string(pr.state);
      const createdAt = string(pr.createdAt);
      const mergeable = string(pr.mergeable);
      if (
        !Number.isFinite(Date.parse(createdAt)) ||
        !["OPEN", "CLOSED", "MERGED"].includes(state) ||
        !["MERGEABLE", "CONFLICTING", "UNKNOWN"].includes(mergeable) ||
        typeof pr.isDraft !== "boolean" ||
        typeof pr.isInMergeQueue !== "boolean" ||
        typeof pr.isMergeQueueEnabled !== "boolean" ||
        !Number.isSafeInteger(pr.number) ||
        (pr.mergedAt !== null &&
          (typeof pr.mergedAt !== "string" ||
            !Number.isFinite(Date.parse(pr.mergedAt)))) ||
        ![pr.autoMergeRequest, pr.mergeQueueEntry].every(
          (v) => v === null || (typeof v === "object" && !Array.isArray(v)),
        )
      )
        throw new Error("GitHub returned invalid CI Pull Request");
      if (
        (state === "MERGED") !== (pr.mergedAt !== null) ||
        (pr.autoMergeRequest !== null &&
          !Number.isFinite(
            Date.parse(string(object(pr.autoMergeRequest).enabledAt)),
          ))
      )
        throw new Error("GitHub returned invalid CI merge evidence");
      if (pr.mergeQueueEntry !== null) string(object(pr.mergeQueueEntry).id);
      const head =
        repo.ref === null ? null : oid(object(object(repo.ref).target).oid);
      const observation: PullRequestObservation = {
        repositoryId: string(repo.id),
        head,
        lastCommit: oid(commit.oid),
        pullRequest: {
          id: string(pr.id),
          number: pr.number as number,
          url: string(pr.url),
          createdAt,
          branch: string(pr.headRefName),
          targetBranch: string(pr.baseRefName),
          headSha: oid(pr.headRefOid),
          state: state.toLowerCase() as "open" | "closed" | "merged",
          draft: pr.isDraft,
          headRepository: string(object(pr.headRepository).nameWithOwner),
        },
        merge: {
          headSha: oid(pr.headRefOid),
          createdAt,
          merged: state === "MERGED" && pr.mergedAt !== null,
          mergeRequested:
            pr.autoMergeRequest !== null || pr.mergeQueueEntry !== null,
          mergeable:
            mergeable === "MERGEABLE"
              ? "mergeable"
              : mergeable === "CONFLICTING"
                ? "conflicting"
                : "unknown",
          mergeFailure:
            state === "CLOSED"
              ? `Pull Request ${number} closed without merging`
              : null,
          mergeStateStatus: string(pr.mergeStateStatus),
          isInMergeQueue: pr.isInMergeQueue,
          isMergeQueueEnabled: pr.isMergeQueueEnabled,
        },
        checks: [],
      };
      if (
        initial &&
        (initial.head !== observation.head ||
          initial.lastCommit !== observation.lastCommit ||
          initial.pullRequest.headSha !== observation.pullRequest.headSha)
      ) {
        changed = true;
        break;
      }
      if (
        initial &&
        JSON.stringify({ ...initial, checks: [] }) !==
          JSON.stringify(observation)
      )
        throw new Error("CI observation changed during pagination");
      initial = observation;
      if (commit.statusCheckRollup === null) {
        if (after !== null)
          throw new Error("CI rollup disappeared during pagination");
        break;
      }
      const raw = object(object(commit.statusCheckRollup).contexts);
      const page = parseConnectionPage(raw);
      if (
        !Number.isSafeInteger(raw.totalCount) ||
        (raw.totalCount as number) < 0 ||
        (total !== undefined && total !== raw.totalCount)
      )
        throw new Error("GitHub returned invalid check count");
      total = raw.totalCount as number;
      contexts.push(...page.nodes.map(project));
      after = page.cursor;
      if (after && cursors.has(after))
        throw new Error("GitHub returned non-advancing check pagination");
      if (after) cursors.add(after);
      else if (contexts.length !== total)
        throw new Error("GitHub returned incomplete checks");
    } while (after);
    if (changed) continue;
    if (!initial) throw new Error("GitHub returned no CI observation");
    const latest = new Map<string, ReturnType<typeof project>>();
    for (const item of contexts)
      if (!latest.has(item.key) || item.time > latest.get(item.key)!.time)
        latest.set(item.key, item);
    initial.checks = [...latest.values()]
      .filter((item) => item.required)
      .map((item) => item.check);
    return initial;
  }
}
