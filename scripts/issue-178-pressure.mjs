/* eslint-disable -- Temporary resource-pressure diagnostic; never merge. */
// @ts-nocheck
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rename,
  unlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const directory = await mkdtemp(path.join(tmpdir(), "issue178-pressure-"));
const until =
  performance.now() + Number(process.env.I178_PRESSURE_MS ?? 180_000);
const data = Buffer.alloc(16384, 97);
let operations = 0;
console.log("[I178-PRESSURE]", JSON.stringify({ directory, lanes: 16 }));
try {
  await Promise.all(
    Array.from({ length: 16 }, async (_, lane) => {
      const file = path.join(directory, String(lane));
      while (performance.now() < until) {
        await writeFile(file, data);
        await rename(file, `${file}.renamed`);
        assert.equal((await readFile(`${file}.renamed`)).length, data.length);
        await unlink(`${file}.renamed`);
        operations += 4;
      }
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
  console.log("[I178-PRESSURE]", JSON.stringify({ operations }));
}
