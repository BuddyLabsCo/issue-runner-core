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

**Enhancement Pause**:
A Core-owned confirmation for an Assignment whose enhancement has paused its own
automation. Acknowledgment notifies that enhancement without pausing other Issues
or handoff observation.
_Avoid_: Operator Pause, recovery pause.

**Operator Pause**:
A workflow intervention requiring an operator decision before Runner continues
affected operations. It retains its intervention policy while waiting behind
another confirmation.
_Avoid_: Enhancement Pause.
