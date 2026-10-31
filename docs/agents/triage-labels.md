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
| e2e-epic | Parent acceptance issue for one E2E test case on one platform |
| e2e-test | Fixture sub-issue executed as part of an E2E acceptance case |
| bug-epic | Parent epic grouping bugs discovered during E2E acceptance |

`e2e-epic` and `e2e-test` are independent of triage status and can coexist with
a triage label. Apply `e2e-epic` to acceptance issues, including cases without
fixtures, and `e2e-test` only to their fixture sub-issues. Do not apply both to
the same issue. Each acceptance issue covers one test case on one platform;
Windows and Linux use separate issues and fixtures.

Discovered bugs use normal triage labels and belong under a separate defect
epic labelled `bug-epic`. Apply `bug-epic` to the parent epic only.
Reserve `e2e-epic` for acceptance cases and `e2e-test` for fixtures.

Follow `docs/agents/issue-tracker.md` for case setup, test branches, execution,
and defect reporting.
