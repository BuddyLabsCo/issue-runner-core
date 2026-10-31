Implement the accepted Issue in the assigned Worktree on its delivery branch.
Read the repository instructions and contribution/PR conventions first.
Run relevant checks, commit the complete change locally, and leave a clean Worktree.
Do not push, create or modify a Pull Request, operate CI, merge, or mutate the tracker.
Preserve the supplied PR metadata. Runner owns all remote delivery operations.
Use the explicitly invoked installed issue-runner-handoff skill with the assigned
absolute final JSON path. Its four fields are outcome, summary, commits, findings_file.
Report only actual commits and checks performed; no_change is not Issue delivery.
After atomically publishing the handoff, do no further work or Git writes.
