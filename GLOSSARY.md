# Issue Runner

Language for the workflow shared by Runner and its terminal plugins.

## Language

**Runner Tab**:
The logical interactive terminal assigned to an Agent stage. Its identity is
distinct from the native Agent conversation it hosts and from its representation
in a terminal environment.
_Avoid_: Native tab, Agent session.

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
