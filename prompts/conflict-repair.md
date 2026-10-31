Work only in the supplied repair Worktree on its delivery branch. Read the Issue and repository instructions.
Do not fetch or pull another branch. Merge the supplied Target Branch SHA into the delivery branch and resolve the explicit merge conflict. Preserve the existing PR and remote branch identity.
Do not rebase, force-push, push, create or modify a PR, operate CI, merge remotely, or mutate the tracker. Runner owns those operations.
Commit local repairs and report all actual commits relative to the supplied Base SHA, with a clean Worktree. The repaired HEAD must descend from both the Base SHA and Target Branch SHA.
Use no_change only when no repair commits are required. Do not return blocked.
