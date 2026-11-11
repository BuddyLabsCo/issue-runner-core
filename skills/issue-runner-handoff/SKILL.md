---
name: issue-runner-handoff
description: Use only when the user or task prompt explicitly requests the issue-runner-handoff skill. Report task completion or a pause requiring user action.
argument-hint: "<absolute-handoff-json-path>"
---

Invoke this skill only when explicitly requested by name.
That request remains active across pauses and user interruptions.
Use this skill when the task completes without requiring another explicit request.
Use the supplied Handoff path or explicit argument as the absolute path of the final JSON handoff file.

## Human action required

Use this branch only when user action is required and no independent work can continue.
Do not create the handoff file.

Your final response starts with literal `[action required]`, with no preceding heading, list marker, or formatting.
Explain the blocker and required action, then stop work and wait for user input.

## Task complete

Only after the assigned work is complete, write the applicable final JSON schema below.

For implementation and documentation assignments, include the nonempty `pr_title`
and `pr_body` strings generated from the completed work and repository Pull Request
conventions. These assignments require both fields for `committed` and `no_change`.
The first implementation after no-change Review findings is an implementation
assignment: return `committed` and fresh PR metadata describing the actual changes.
Review, ordinary Review-fix, CI-repair, and conflict-repair assignments use only `outcome`,
`summary`, `commits`, and `findings_file`; omit PR metadata for those purposes.

For implementation or documentation, write one JSON object with exactly these fields:

```json
{
  "outcome": "committed",
  "summary": "Added missing-configuration handling and regression coverage. The focused tests passed; the full suite was not run.",
  "commits": [
    {
      "sha": "0123456789abcdef0123456789abcdef01234567",
      "message": "fix: handle missing configuration"
    }
  ],
  "findings_file": null,
  "pr_title": "fix: handle missing configuration",
  "pr_body": "Explain the completed change and follow the repository's PR conventions."
}
```

`outcome`:
- `committed`: execution produced Git commits containing the task's changes.
- `no_change`: execution concluded that the task requires no changes.
- `passed`: Review found no actionable issues in the reviewed changes.
- `findings`: Review found actionable issues recorded in its findings report.

`summary`: briefly explain what was implemented or reviewed and why the
outcome applies. Include verification actually performed, its results,
and relevant limitations. Report only work and checks actually performed.
For no-change assessments and reviews, state why requirements are satisfied,
the actual checks and results, and any limitations.

`commits` depends on `outcome`:

- `passed`, `findings`, or `no_change`: always `[]`.
  A Review's commit range identifies existing commits to inspect.
  Do not include those reviewed commits in the handoff.

- `committed`: a nonempty list of this execution's commits,
  each with its full SHA and message.
  If an execution commit range is supplied, include every commit
  in that range, including commits introduced by a merge.

`findings_file`: the findings report's absolute path for `findings`;
otherwise `null`.

Write the JSON to `<handoff-path>.tmp` in the final file's directory.
Validate the JSON against the applicable schema and close the temporary file.

As the final step, atomically rename the temporary file to the final path,
replacing the existing final file if present.
After publishing the final file, stop. Do not modify files, create commits, or perform further task work.
