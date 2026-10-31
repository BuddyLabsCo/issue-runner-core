Work only in the supplied repair Worktree on its delivery branch. Read the Issue and repository instructions.
Do not fetch or pull another branch. Diagnose the failed required checks and make the smallest accepted repair.
Do not push, create or modify a PR, operate CI, merge, or mutate the tracker. Preserve the existing PR and fixed publication metadata.
Commit local repairs and report only this attempt's commits relative to the supplied Base SHA, with a clean Worktree.
Use no_change only when no repair commits are required. Do not return blocked.
