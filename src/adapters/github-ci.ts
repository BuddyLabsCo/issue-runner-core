import type { GitHubClient } from "./github-client.ts";
import type { CiObservation, RequiredCheck } from "../run/contracts.ts";

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("GitHub returned incomplete CI observation");
  return value as Record<string, unknown>;
};
const string = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim())
    throw new Error("GitHub returned invalid CI observation");
  return value;
};
const sha = (value: unknown): string => {
  const result = string(value);
  if (!oid.test(result)) throw new Error("GitHub returned invalid CI head");
  return result;
};

export async function observeCi(
  client: GitHubClient,
  input: { repository: string; branch: string; number: number },
): Promise<CiObservation> {
  const [owner, name] = input.repository.split("/");
  // A changed head invalidates all pages; retry the complete observation.
  for (;;) {
    let after: string | null = null;
    const cursors = new Set<string>();
    const contexts: Record<string, unknown>[] = [];
    let initial: CiObservation | undefined;
    let total: number | undefined;
    let restart = false;
    do {
      const response = await client.graphql(
        `query($owner:String!,$name:String!,$number:Int!,$ref:String!,$after:String){repository(owner:$owner,name:$name){id nameWithOwner ref(qualifiedName:$ref){target{oid}} pullRequest(number:$number){id number url headRefName baseRefName headRefOid headRepository{nameWithOwner} baseRepository{id nameWithOwner} state isDraft createdAt mergedAt mergeable mergeStateStatus isInMergeQueue isMergeQueueEnabled autoMergeRequest{enabledAt} mergeQueueEntry{id} commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{__typename ... on CheckRun{name status conclusion startedAt completedAt detailsUrl isRequired(pullRequestNumber:$number) checkSuite{workflowRun{event workflow{name}}}} ... on StatusContext{context state targetUrl createdAt isRequired(pullRequestNumber:$number)}}}}}}}}}}`,
        {
          owner,
          name,
          number: input.number,
          ref: `refs/heads/${input.branch}`,
          after,
        },
      );
      if (response.commandError || response.errors !== undefined)
        throw new Error("GitHub returned incomplete CI observation");
      const repo = object(object(response.data).repository);
      if (
        string(repo.nameWithOwner).toLowerCase() !==
        input.repository.toLowerCase()
      )
        throw new Error("CI repository mismatch");
      const pr = object(repo.pullRequest);
      const base = object(pr.baseRepository);
      const headRepo = object(pr.headRepository);
      if (
        string(base.id) !== string(repo.id) ||
        string(base.nameWithOwner).toLowerCase() !==
          input.repository.toLowerCase() ||
        string(headRepo.nameWithOwner).toLowerCase() !==
          input.repository.toLowerCase()
      )
        throw new Error("CI repository mismatch");
      const commits = object(pr.commits).nodes;
      if (!Array.isArray(commits) || commits.length !== 1)
        throw new Error("GitHub returned missing last commit");
      const commit = object(object(commits[0]).commit);
      const head = sha(pr.headRefOid);
      const remoteHead =
        repo.ref === null ? null : sha(object(object(repo.ref).target).oid);
      const lastCommit = sha(commit.oid);
      if (
        !Number.isSafeInteger(pr.number) ||
        (pr.number as number) <= 0 ||
        typeof pr.isDraft !== "boolean" ||
        !["OPEN", "CLOSED", "MERGED"].includes(String(pr.state)) ||
        !["MERGEABLE", "CONFLICTING", "UNKNOWN"].includes(
          String(pr.mergeable),
        ) ||
        typeof pr.isInMergeQueue !== "boolean" ||
        typeof pr.isMergeQueueEnabled !== "boolean" ||
        typeof pr.mergeStateStatus !== "string" ||
        ![
          "BEHIND",
          "BLOCKED",
          "CLEAN",
          "DIRTY",
          "DRAFT",
          "HAS_HOOKS",
          "UNKNOWN",
          "UNSTABLE",
        ].includes(pr.mergeStateStatus) ||
        (pr.mergedAt !== null && typeof pr.mergedAt !== "string") ||
        ![pr.autoMergeRequest, pr.mergeQueueEntry].every(
          (v) => v === null || (typeof v === "object" && !Array.isArray(v)),
        )
      )
        throw new Error("GitHub returned invalid CI state");
      const createdAt = string(pr.createdAt);
      if (
        !Number.isFinite(Date.parse(createdAt)) ||
        (pr.mergedAt !== null && !Number.isFinite(Date.parse(pr.mergedAt)))
      )
        throw new Error("GitHub returned invalid CI date");
      const current: CiObservation = {
        repositoryId: string(repo.id),
        remoteHead,
        lastCommit,
        pullRequest: {
          id: string(pr.id),
          number: pr.number as number,
          url: string(pr.url),
          branch: string(pr.headRefName),
          targetBranch: string(pr.baseRefName),
          headSha: head,
          state: String(pr.state).toLowerCase() as "open" | "closed" | "merged",
          draft: pr.isDraft,
          createdAt,
        },
        state: {
          headSha: head,
          createdAt,
          merged: pr.state === "MERGED" || pr.mergedAt !== null,
          mergeRequested:
            pr.autoMergeRequest !== null ||
            pr.mergeQueueEntry !== null ||
            pr.isInMergeQueue,
          mergeable:
            pr.mergeable === "MERGEABLE"
              ? "mergeable"
              : pr.mergeable === "CONFLICTING"
                ? "conflicting"
                : "unknown",
          mergeFailure:
            pr.state === "CLOSED" && pr.mergedAt === null
              ? `Pull Request ${input.number} closed without merging`
              : null,
          mergeStateStatus: pr.mergeStateStatus,
          isInMergeQueue: pr.isInMergeQueue,
          isMergeQueueEnabled: pr.isMergeQueueEnabled,
        },
        checks: [],
      };
      if (
        initial &&
        (initial.pullRequest.headSha !== head ||
          initial.remoteHead !== remoteHead ||
          initial.lastCommit !== lastCommit)
      ) {
        restart = true;
        break;
      }
      if (
        initial &&
        JSON.stringify({ ...initial, checks: [] }) !== JSON.stringify(current)
      )
        throw new Error("CI observation changed during pagination");
      initial = current;
      if (commit.statusCheckRollup === null) {
        if (after !== null)
          throw new Error("CI rollup changed during pagination");
        break;
      }
      const connection = object(object(commit.statusCheckRollup).contexts);
      const page = object(connection.pageInfo);
      if (
        !Array.isArray(connection.nodes) ||
        !Number.isSafeInteger(connection.totalCount) ||
        (connection.totalCount as number) < 0 ||
        typeof page.hasNextPage !== "boolean" ||
        (page.endCursor !== null && typeof page.endCursor !== "string") ||
        (total !== undefined && total !== connection.totalCount)
      )
        throw new Error("GitHub returned incomplete CI contexts");
      total = connection.totalCount as number;
      contexts.push(...connection.nodes.map(object));
      if (page.hasNextPage) {
        const cursor = string(page.endCursor);
        if (
          cursors.has(cursor) ||
          connection.nodes.length === 0 ||
          contexts.length >= total
        )
          throw new Error("GitHub returned invalid CI cursor");
        cursors.add(cursor);
        after = cursor;
      } else {
        if (contexts.length !== total)
          throw new Error("GitHub returned truncated CI contexts");
        after = null;
      }
    } while (after !== null);
    if (restart) continue;
    const latest = new Map<
      string,
      { time: number; required: boolean; check: RequiredCheck }
    >();
    for (const context of contexts) {
      if (typeof context.isRequired !== "boolean")
        throw new Error("GitHub returned invalid required check");
      let key: string,
        name: string,
        state: string,
        link: unknown,
        date: unknown;
      if (context.__typename === "StatusContext") {
        name = string(context.context);
        state = string(context.state);
        link = context.targetUrl;
        date = context.createdAt;
        key = JSON.stringify(["status", name]);
      } else if (context.__typename === "CheckRun") {
        name = string(context.name);
        const status = string(context.status);
        state =
          status === "COMPLETED" && context.conclusion !== null
            ? string(context.conclusion)
            : status;
        link = context.detailsUrl;
        date = context.startedAt;
        const suite =
          context.checkSuite === null ? null : object(context.checkSuite);
        const run =
          suite?.workflowRun === null || !suite
            ? null
            : object(suite.workflowRun);
        const workflow =
          run?.workflow === null || !run ? null : object(run.workflow);
        key = JSON.stringify([
          "check",
          name,
          workflow ? string(workflow.name) : "",
          run ? string(run.event) : "",
        ]);
      } else throw new Error("GitHub returned unknown CI context");
      if (link !== null && typeof link !== "string")
        throw new Error("GitHub returned invalid check link");
      const time = date === null ? 0 : Date.parse(string(date));
      if (!Number.isFinite(time))
        throw new Error("GitHub returned invalid check date");
      const bucket: RequiredCheck["bucket"] =
        state === "SUCCESS"
          ? "pass"
          : ["SKIPPED", "NEUTRAL"].includes(state)
            ? "skipping"
            : ["ERROR", "FAILURE", "TIMED_OUT", "ACTION_REQUIRED"].includes(
                  state,
                )
              ? "fail"
              : state === "CANCELLED"
                ? "cancel"
                : "pending";
      const previous = latest.get(key);
      if (!previous || time > previous.time)
        latest.set(key, {
          time,
          required: context.isRequired,
          check: { name, state, link: link ?? "", bucket },
        });
    }
    initial.checks = [...latest.values()]
      .filter((item) => item.required)
      .map((item) => item.check);
    return initial;
  }
}
