import { readFileSync } from "node:fs";

export function loadPrompt(name: string): string {
  return readFileSync(
    new URL(`../../prompts/${name}.md`, import.meta.url),
    "utf8",
  ).trimEnd();
}

export function renderPrompt(
  template: string,
  values: Record<string, string | undefined>,
): string {
  return template.replace(/\{\{(\w+)\}\}/gu, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`Missing prompt value: ${key}`);
    return value;
  });
}
