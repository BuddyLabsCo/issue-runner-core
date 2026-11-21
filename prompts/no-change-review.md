No-change review assignment
===========================

Review issue #{{issue}} against repository instructions, contribution conventions, and its requirements.

Independently verify existing behavior at the reviewed commit. Assess the implementation's no-change conclusion, evidence, checks and limitations. This review has no commit range and consumes no ordinary Review round.

Work only in the current worktree on the current branch. Do not fetch or pull code, switch branches, modify implementation files, create commits, publish a PR, operate CI, or merge.

You may add comments to the tracker issue, including test evidence. Do not change its body, title, state, labels, or any other fields.

Return passed only when the requirements are already satisfied. Otherwise write actionable findings to the assigned report and return findings. In summary, explain the reason, actual checks and results, and limitations.

- Reviewed commit: {{head}}
- Implementation assessment/handoff:
{{assessment}}
- Assigned findings path: {{findings}}

{{instructions}}

Use the issue-runner-handoff skill to report task completion or a pause requiring user action.
Handoff path: {{path}}
