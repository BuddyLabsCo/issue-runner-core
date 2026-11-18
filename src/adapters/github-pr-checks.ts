import { nonempty, object } from "../agent/handoff.ts";
import type {
  PullRequestMergeFacts,
  PullRequestState,
  RequiredCheck,
} from "../run/contracts.ts";

export const branchFields =
  "id nameWithOwner ref(qualifiedName: $ref) { name target { oid } }";
export const publicationFields = `
  id number url headRefName baseRefName headRefOid state isDraft createdAt
  repository { id nameWithOwner }
  headRepository { id nameWithOwner }
`;
export const mergeFields = `
  mergedAt mergeable mergeStateStatus isInMergeQueue isMergeQueueEnabled
  autoMergeRequest { enabledAt }
  mergeQueueEntry { id }
`;
export const pollQuery = `
  query Poll($owner: String!, $name: String!, $number: Int!, $ref: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      ${branchFields}
      pullRequest(number: $number) {
        ${publicationFields}
        ${mergeFields}
        commits(last: 1) {
          nodes { commit { oid statusCheckRollup {
            contexts(first: 100, after: $after) {
              totalCount
              pageInfo { hasNextPage endCursor }
              nodes {
                __typename
                ... on CheckRun {
                  id name status conclusion startedAt detailsUrl
                  isRequired(pullRequestNumber: $number)
                  checkSuite { workflowRun { event workflow { name } } }
                }
                ... on StatusContext {
                  id context state targetUrl
                  isRequired(pullRequestNumber: $number)
                }
              }
            }
          } } }
        }
      }
    }
  }
`;

export const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function parsePullRequestState(
  row: unknown,
  pullRequest: number,
): PullRequestState {
  const value = object(row);
  if (
    typeof value.headRefOid !== "string" ||
    !oid.test(value.headRefOid) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !["OPEN", "CLOSED", "MERGED"].includes(String(value.state)) ||
    !["MERGEABLE", "CONFLICTING", "UNKNOWN"].includes(
      String(value.mergeable),
    ) ||
    (value.mergedAt !== null &&
      (typeof value.mergedAt !== "string" ||
        !Number.isFinite(Date.parse(value.mergedAt)))) ||
    ![value.autoMergeRequest, value.mergeQueueEntry].every(
      (entry) =>
        entry === null || (typeof entry === "object" && !Array.isArray(entry)),
    )
  )
    throw new Error("GitHub returned invalid Pull Request state");
  const merged = value.state === "MERGED" || value.mergedAt !== null;
  return {
    headSha: value.headRefOid,
    createdAt: value.createdAt,
    merged,
    mergeRequested:
      value.autoMergeRequest !== null || value.mergeQueueEntry !== null,
    mergeable:
      value.mergeable === "MERGEABLE"
        ? "mergeable"
        : value.mergeable === "CONFLICTING"
          ? "conflicting"
          : "unknown",
    mergeFailure:
      value.state === "CLOSED" && !merged
        ? `Pull Request ${pullRequest} closed without merging`
        : null,
  };
}

export function parseMergeFacts(
  row: Record<string, unknown>,
  number: number,
): PullRequestMergeFacts {
  const state = parsePullRequestState(row, number);
  const { mergeStateStatus, isInMergeQueue, isMergeQueueEnabled } = row;
  const autoMergeEnabledAt =
    row.autoMergeRequest === null
      ? null
      : object(row.autoMergeRequest).enabledAt;
  const mergeQueueEntryId =
    row.mergeQueueEntry === null ? null : object(row.mergeQueueEntry).id;
  if (
    !nonempty(mergeStateStatus) ||
    typeof isInMergeQueue !== "boolean" ||
    typeof isMergeQueueEnabled !== "boolean" ||
    (row.autoMergeRequest !== null && autoMergeEnabledAt === null) ||
    (autoMergeEnabledAt !== null &&
      (typeof autoMergeEnabledAt !== "string" ||
        !Number.isFinite(Date.parse(autoMergeEnabledAt)))) ||
    (row.mergeQueueEntry !== null && mergeQueueEntryId === null) ||
    (mergeQueueEntryId !== null && !nonempty(mergeQueueEntryId)) ||
    (row.state === "MERGED") !== (row.mergedAt !== null)
  )
    throw new Error("GitHub returned invalid Pull Request merge facts");
  return {
    ...state,
    mergeRequested: state.mergeRequested || isInMergeQueue,
    mergeStateStatus,
    isInMergeQueue,
    isMergeQueueEnabled,
    autoMergeEnabledAt,
    mergeQueueEntryId,
  };
}

export function parseCheckContext(value: unknown) {
  const row = object(value);
  const { __typename, isRequired } = row;
  if (typeof isRequired !== "boolean")
    throw new Error("GitHub returned a check context without required status");
  if (__typename === "StatusContext") {
    const { context: name, state, targetUrl } = row;
    if (
      !nonempty(name) ||
      !nonempty(state) ||
      (targetUrl !== null && typeof targetUrl !== "string")
    )
      throw new Error("GitHub returned an invalid Status Context");
    return {
      key: JSON.stringify([name]),
      name,
      state,
      link: targetUrl ?? "",
      isRequired,
      startedAt: -Infinity,
    };
  }
  if (__typename !== "CheckRun")
    throw new Error("GitHub returned an unknown check context type");
  const { name, status, conclusion, detailsUrl, startedAt } = row;
  if (
    !nonempty(name) ||
    !nonempty(status) ||
    (conclusion !== null && !nonempty(conclusion)) ||
    (detailsUrl !== null && typeof detailsUrl !== "string") ||
    (startedAt !== null &&
      (typeof startedAt !== "string" ||
        !Number.isFinite(Date.parse(startedAt))))
  )
    throw new Error("GitHub returned an invalid Check Run");
  const run =
    row.checkSuite === null ? null : object(row.checkSuite).workflowRun;
  const event = run === null ? "" : object(run).event;
  const workflow = run === null ? null : object(run).workflow;
  const workflowName = workflow === null ? "" : object(workflow).name;
  if (typeof event !== "string" || typeof workflowName !== "string")
    throw new Error("GitHub returned an invalid Check Run workflow");
  return {
    key: JSON.stringify([name, workflowName, event]),
    name,
    state: status === "COMPLETED" ? (conclusion ?? "") : status,
    link: detailsUrl ?? "",
    isRequired,
    startedAt: startedAt === null ? -Infinity : Date.parse(startedAt),
  };
}

export function requiredChecks(
  contexts: ReturnType<typeof parseCheckContext>[],
): RequiredCheck[] {
  // gh orders by Check Run start time before deduplicating and filtering.
  contexts.sort((left, right) => right.startedAt - left.startedAt);
  const seen = new Set<string>();
  const checks: RequiredCheck[] = [];
  for (const { key, isRequired, name, state, link } of contexts) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (isRequired)
      checks.push({ name, state, link, bucket: checkBucket(state) });
  }
  return checks;
}

function checkBucket(state: string): RequiredCheck["bucket"] {
  switch (state) {
    case "SUCCESS":
      return "pass";
    case "SKIPPED":
    case "NEUTRAL":
      return "skipping";
    case "ERROR":
    case "FAILURE":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
      return "fail";
    case "CANCELLED":
      return "cancel";
    default:
      return "pending";
  }
}
