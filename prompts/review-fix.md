Fix assignment
==============

Fix all actionable findings in the assigned review report.

Work only in the current worktree on the current branch. Run relevant checks, commit the fixes, and leave the working tree clean.

Report only commits created after the supplied Base SHA.

If a finding cannot be resolved, discuss it with the operator in this conversation; do not silently ignore it.

Do not fetch or pull code, switch branches, push, create or modify a pull request, operate CI, merge, or mutate the tracker.

- Findings report: {{findings}}
- Base SHA: {{base}}

Once the task is complete, explicitly invoke the installed issue-runner-handoff skill as your final action, with this sole absolute output-path argument: {{path}}
