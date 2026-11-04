export function terminalSettings(input: Record<string, unknown>) {
  const { agentStartDelay = 10, enhancements = {} } = input;
  if (
    typeof agentStartDelay !== "number" ||
    !Number.isFinite(agentStartDelay) ||
    agentStartDelay < 0 ||
    agentStartDelay * 1000 > 2_147_483_647
  )
    throw new Error(
      "terminalPlugins.agentStartDelay must be finite nonnegative seconds within the timer limit",
    );
  if (
    typeof enhancements !== "object" ||
    enhancements === null ||
    Object.getPrototypeOf(enhancements) !== Object.prototype
  )
    throw new Error("terminalPlugins.enhancements must be an object mapping");
  return {
    ...input,
    agentStartDelay,
    enhancements: enhancements as Record<string, unknown>,
  };
}
