import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["coverage/**", "dist/**"] },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "max-lines": [
        "error",
        { max: 500, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    files: ["src/**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
    ignores: ["src/adapters/**", "src/cli.*"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "node:os",
            "os",
            "node:process",
            "process",
            "node:child_process",
            "child_process",
            "node:module",
            "module",
            "node:path/win32",
            "node:path/posix",
          ],
          patterns: [
            {
              regex: "(^|/)adapters(/|$)",
              message:
                "Depend on contracts; wire concrete adapters in the CLI.",
            },
            {
              group: [
                "@anthropic-ai/*",
                "@openai/*",
                "openai",
                "openai/*",
                "@google/genai",
                "@google/gemini-cli*",
                "@ai-hero/sandcastle",
                "issue-runner-*",
                "!issue-runner-core",
                "!issue-runner-core/**",
              ],
              message:
                "Keep Agent SDKs and terminal plugins outside business logic.",
            },
          ],
        },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "platform",
          message: "Keep OS decisions in adapters.",
        },
        {
          object: "process",
          property: "arch",
          message: "Keep OS decisions in adapters.",
        },
        {
          object: "path",
          property: "win32",
          message: "Use portable path operations.",
        },
        {
          object: "path",
          property: "posix",
          message: "Use portable path operations.",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message:
            "Load plugins in adapters; use static dependencies in business logic.",
        },
        {
          selector: "CallExpression[callee.name='require']",
          message: "Use static dependencies in business logic.",
        },
      ],
    },
  },
);
