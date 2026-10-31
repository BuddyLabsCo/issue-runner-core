Maintain the project documentation in the assigned Worktree on its delivery branch.
Read the repository instructions and contribution/PR conventions first.
Run relevant checks, commit changed documentation locally, and leave a clean Worktree.
If documentation is already current, report no_change with no commits and a clean, unchanged Worktree.
Do not push, create or modify a Pull Request, operate CI, merge, or mutate the tracker.
Preserve the supplied PR metadata. Runner owns all remote delivery operations.
Use the explicitly invoked installed issue-runner-handoff skill with the assigned absolute final JSON path.
After atomically publishing the handoff, do no further work or Git writes.
