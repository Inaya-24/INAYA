import assert from "node:assert/strict";
import test from "node:test";
import { createUploadPlan, MAX_CHUNK_SIZE } from "../src/tiktok/uploadPlan.js";

test("small videos are transferred in one complete chunk", () => {
  const size = 4 * 1024 * 1024;
  const plan = createUploadPlan(size);
  assert.equal(plan.totalChunkCount, 1);
  assert.deepEqual(plan.chunks, [{ start: 0, end: size - 1, length: size }]);
});

test("large videos merge the remainder into the final sequential chunk", () => {
  const size = MAX_CHUNK_SIZE * 2 + 123;
  const plan = createUploadPlan(size);
  assert.equal(plan.totalChunkCount, 2);
  assert.equal(plan.chunks[0].length, MAX_CHUNK_SIZE);
  assert.equal(plan.chunks[1].length, MAX_CHUNK_SIZE + 123);
  assert.equal(plan.chunks[1].end, size - 1);
});

test("empty videos are rejected", () => assert.throws(() => createUploadPlan(0), TypeError));
