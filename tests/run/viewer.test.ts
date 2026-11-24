import assert from "node:assert/strict";
import test from "node:test";
import { cachedViewer } from "../../src/run/viewer.ts";

const first = { id: "first-id", login: "first" };
const second = { id: "second-id", login: "second" };

await test("cached viewer loads once for sequential and concurrent reads", async () => {
  let loads = 0;
  let resolve!: (viewer: typeof first) => void;
  const viewer = cachedViewer(() => {
    loads += 1;
    return new Promise((done) => {
      resolve = done;
    });
  });

  const pending = [viewer.read(), viewer.read()];
  assert.equal(loads, 1);
  resolve(first);

  assert.deepEqual(await Promise.all(pending), [first, first]);
  assert.deepEqual(await viewer.read(), first);
  assert.equal(loads, 1);
});

await test("cached viewer retries a rejected load", async () => {
  let loads = 0;
  const viewer = cachedViewer(() => {
    loads += 1;
    return loads === 1
      ? Promise.reject(new Error("viewer unavailable"))
      : Promise.resolve(first);
  });

  await assert.rejects(viewer.read(), /viewer unavailable/u);
  assert.deepEqual(await viewer.read(), first);
  assert.equal(loads, 2);
});

await test("cached viewer keeps the first seeded identity over a later load", async () => {
  let loads = 0;
  let resolve!: (viewer: typeof second) => void;
  const viewer = cachedViewer(() => {
    loads += 1;
    return new Promise((done) => {
      resolve = done;
    });
  });

  const pending = viewer.read();
  viewer.seed(first);
  resolve(second);

  assert.deepEqual(await pending, first);
  assert.deepEqual(await viewer.read(), first);
  assert.equal(loads, 1);
});
