No-change fix assignment
========================

Implement issue #{{issue}} by resolving all actionable findings from the no-change review.

Work only in the current worktree on the current branch. Run relevant checks, commit the complete change locally, and leave the working tree clean. Report only commits after the supplied Base SHA.

Return committed with fresh, nonempty pr_title and pr_body following repository Pull Request conventions and describing the actual implementation. Include both fields in this implementation handoff. A no_change result cannot satisfy findings. In summary, explain the reason, actual checks and results, and limitations.

If a finding cannot be resolved, discuss it with the operator in this conversation.

Do not fetch or pull code, switch branches, push, create or modify a pull request, operate CI, merge, or mutate the tracker.

- Findings report: {{findings}}
- Base SHA: {{base}}

Use the issue-runner-handoff skill to report task completion or a pause requiring user action.
Handoff path: {{path}}
