import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import {
  testPromptAssembly,
  testPromptContinuation,
} from "../support/prompt-assembly.ts";

await test("prompt assembly preserves literal context, separate submissions and waits", (t) =>
  testPromptAssembly(t, executeCli));

await test("retained prompt assignments resume with only continue after startup", (t) =>
  testPromptContinuation(t, executeCli));
