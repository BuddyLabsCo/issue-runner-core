import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadPrompt, renderPrompt } from "./load.ts";
import { documentationInstructions } from "./documentation.ts";

export const implementationInstructions = loadPrompt("implement");

export async function executionPrompt(
  directory: string,
  purpose: "implement" | "documentation",
  issue: number,
  handoffPath: string,
): Promise<string> {
  const template =
    purpose === "documentation"
      ? documentationInstructions
      : implementationInstructions;
  const file = path.join(directory, "prompts", `${purpose}.md`);
  return renderPrompt(template, {
    issue: String(issue),
    instructions: await readFile(file, "utf8"),
    path: JSON.stringify(handoffPath),
  });
}
