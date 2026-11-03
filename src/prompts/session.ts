import { loadPrompt } from "./load.ts";

export const probeInstructions = loadPrompt("probe");
export const probeCorrectionInstructions = loadPrompt("probe-correction");
export const probeRecoveryInstructions = loadPrompt("probe-recovery");
export const handoffCorrectionInstructions = loadPrompt("handoff-correction");
export const resumeInstructions = loadPrompt("resume");
export const recoveryInstructions = loadPrompt("recovery");
