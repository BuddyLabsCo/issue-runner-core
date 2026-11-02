Review assignment
=================

Review issue #{{issue}} against repository instructions, contribution conventions, and the issue requirements.

Read the issue and surrounding code as needed. Review the supplied commit range and verify any previous findings are resolved.

Work only in the current worktree on the current branch. Do not fetch or pull code or switch branches.

Do not modify implementation files or create commits. Write actionable findings only to the assigned report path.

- Review round: {{round}}
- Review base: {{base}}
- Implementation HEAD: {{head}}
- Assigned findings path: {{findings}}
  
{{instructions}}

Once the task is complete, explicitly invoke the installed issue-runner-handoff skill as your final action, with this sole absolute output-path argument: {{path}}
