import { loadPrompt } from "./load.ts";

export const probeInstructions = loadPrompt("probe");
export const probeMetadataInstructions = loadPrompt("probe-metadata");
export const probeCorrectionInstructions = loadPrompt("probe-correction");
export const handoffCorrectionInstructions = loadPrompt("handoff-correction");
export const resumeInstructions = loadPrompt("resume");
