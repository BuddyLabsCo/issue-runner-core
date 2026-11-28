# Issue Runner

Language for the workflow shared by Runner and its platform adapters.

## Language

**Run**:
One invocation of the Runner workflow, from CLI launch to termination. A Run may
process multiple Issues concurrently.

**Agent Session**:
A Core-managed Agent execution unit assigned to a stage. Its identity is distinct
from the native conversation and its representation on the platform.
_Avoid_: Runner Tab, native tab, thread, pane.

**Native Session Reference**:
A persistent identifier of the actual native Agent conversation, used to recover
that same conversation.
_Avoid_: Agent Session ID, tab handle.

**Pause**:
A Core workflow intervention requiring an operator decision before affected
operations continue. It retains its scope while queued for confirmation.
