Conflict repair assignment
==========================

Resolve the pull request merge conflict for issue #{{issue}}.

Read the issue and repository instructions.

The target commit is already available locally.

Merge the supplied Target Branch SHA into the current branch and resolve conflicts while preserving both changes' intended behavior.

Work only in the current worktree on the current branch. Run relevant checks, commit local repairs, and leave the working tree clean.

Report all commits after the supplied Base SHA, including commits introduced by the merge.

Do not switch branches, rebase, push, create or modify a pull request, operate CI, or merge remotely.

You may add comments to the tracker issue, including test evidence. Do not change its body, title, state, labels, or any other fields.

- PR: {{pr}}
- Base SHA: {{base}}
- Target Branch SHA: {{target_base}}
- Merge conflict: {{conflict}}

Use the issue-runner-handoff skill to report task completion or a pause requiring user action.
Handoff path: {{path}}
