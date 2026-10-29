# Triage labels

Use these label strings when a skill refers to a canonical triage role.

| Role | Tracker label | Meaning |
| --- | --- | --- |
| needs-triage | needs-triage | Maintainer needs to evaluate the issue |
| needs-info | needs-info | Waiting on the reporter for more information |
| ready-for-agent | ready-for-agent | Fully specified and ready for an AI agent |
| ready-for-human | ready-for-human | Requires human implementation |
| wontfix | wontfix | Will not be actioned |

## Task labels

| Label | Meaning |
| --- | --- |
| e2e-test | End-to-end test task for an AI agent to execute and discover problems |

`e2e-test` is independent of triage status and can coexist with a triage label.
Follow `docs/agents/issue-tracker.md` for reporting discovered problems as sub-issues.
