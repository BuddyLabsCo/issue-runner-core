import { loadPrompt } from "./load.ts";

export const probeInstructions = loadPrompt("probe");
export const probeMetadataInstructions = loadPrompt("probe-metadata");
export const probeReviewInstructions = loadPrompt("probe-review");
export const probeRepairInstructions = loadPrompt("probe-repair");
export const probeCorrectionInstructions = loadPrompt("probe-correction");
export const handoffInvocationInstructions = loadPrompt("handoff-invocation");
export const handoffCorrectionInstructions = loadPrompt("handoff-correction");
