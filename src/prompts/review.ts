import { loadPrompt } from "./load.ts";

export const reviewInstructions = loadPrompt("review");
export const reviewFixInstructions = loadPrompt("review-fix");
