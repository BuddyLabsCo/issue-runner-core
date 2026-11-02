/* eslint-disable -- Temporary diagnostic instrumentation; never merge. */
// @ts-nocheck
import fs from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

if (/cli-(batch|cancellation)\.test\.ts$/u.test(process.argv[1] ?? "")) {
  const events = [];
  const active = new Map();
  let id = 0;
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  process.on("issue178", (label, detail) => {
    const event = { kind: "milestone", label, at: performance.now(), detail };
    events.push(event);
    console.log(
      "[I178]",
      JSON.stringify({
        ...event,
        active: [...active.values()].map((op) => ({
          ...op,
          elapsed: performance.now() - op.start,
        })),
        loopMaxMs: loop.max / 1e6,
      }),
    );
  });
  for (const name of [
    "readFile",
    "writeFile",
    "appendFile",
    "mkdir",
    "rename",
    "rm",
    "stat",
    "readdir",
  ]) {
    const original = fs[name];
    fs[name] = async (...args) => {
      const entry = {
        kind: "fs",
        id: ++id,
        op: name,
        path: String(args[0]),
        start: performance.now(),
      };
      if (
        name === "appendFile" &&
        typeof args[1] === "string" &&
        args[1].startsWith("{")
      ) {
        const audit = JSON.parse(args[1]);
        entry.audit = {
          phase: audit.phase,
          operation: audit.operation,
          result: audit.result,
        };
      }
      active.set(entry.id, entry);
      try {
        return await Reflect.apply(original, fs, args);
      } catch (error) {
        entry.code = error.code;
        throw error;
      } finally {
        entry.end = performance.now();
        active.delete(entry.id);
        events.push(entry);
      }
    };
  }
  syncBuiltinESMExports();
  process.on("exit", () => {
    loop.disable();
    const directory = process.env.I178_TRACE_DIR ?? "diagnostic-traces";
    mkdirSync(directory, { recursive: true });
    const trace = {
      file: process.argv[1],
      pid: process.pid,
      version: process.version,
      timeOrigin: performance.timeOrigin,
      pressure: process.env.I178_PRESSURE ?? "0",
      platform: process.platform,
      mode: process.env.I178_OBSERVE ?? "original",
      loopMaxMs: loop.max / 1e6,
      loopMeanMs: loop.mean / 1e6,
      active: [...active.values()],
      events,
    };
    writeFileSync(
      path.join(
        directory,
        `${path.basename(process.argv[1])}-${process.pid}-${Date.now()}.json`,
      ),
      JSON.stringify(trace),
    );
  });
}
