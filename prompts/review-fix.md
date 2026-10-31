Continue in the original implementation conversation.
Read the assigned reviewer-written findings report and fix all actionable findings.
Run relevant checks, commit the fixes in the supplied Worktree on its delivery branch, and leave it clean.
Report only commits created after the supplied fix Base SHA. A no_change result cannot satisfy findings.
If you cannot resolve a finding, work with the operator in this native conversation; do not silently ignore it.
Do not fetch or pull another branch, push, create or modify a Pull Request, operate CI, merge, or mutate the tracker.
Preserve the fixed PR metadata. Explicitly invoke issue-runner-handoff with the assigned output path.
After atomically publishing the handoff, do no further work or Git writes.
