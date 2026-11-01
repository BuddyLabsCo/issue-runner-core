---
name: issue-runner-handoff
description: Write the current task's JSON handoff.
disable-model-invocation: true
argument-hint: "<absolute-handoff-json-path>"
---

Invoke this skill only after the assigned task is complete.
Use the argument as the absolute path of the final JSON handoff file.

Write one JSON object with exactly these fields:

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
  "findings_file": null
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

`commits`: this task's commits, each with its full SHA and message.
When the task supplies a commit range, include every commit in that range, including commits introduced by a merge.
Nonempty for `committed`; otherwise `[]`.

`findings_file`: the findings report's absolute path for `findings`;
otherwise `null`.

Write the JSON to `<handoff-path>.tmp` in the final file's directory.
Validate the JSON and close the temporary file.

As the final step, atomically rename the temporary file to the final path,
replacing the existing final file if present.
After publishing the final file, stop. Do not modify files, create commits, or perform further task work.
