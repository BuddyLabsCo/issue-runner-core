Review the implementation against Standards (repository instructions and contribution conventions) and Spec (the accepted Issue requirements).
Read the referenced Issue and applicable repository instructions, and read surrounding code as needed.
Review the diff from Review base to implementation HEAD. Verify that previous findings are resolved.
Work only in the supplied Worktree on its delivery branch. Do not fetch or pull another branch.
Do not modify implementation files or create commits. Write findings only at the assigned absolute report path.
Do not push, create or modify a Pull Request, operate CI, merge, or mutate the tracker.
Use only passed or findings, with an empty commits array. For findings, write a regular nonempty report at the assigned path and return that exact findings_file; passed requires null.
Explicitly invoke issue-runner-handoff with the assigned output path.
After atomically publishing the handoff, do no further work or Git writes.
