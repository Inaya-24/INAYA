import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fingerprintVideo } from "../src/agent/videoFingerprint.js";

test("creates a stable SHA-256 fingerprint from video bytes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "inaya-fingerprint-test-"));
  const first = path.join(directory, "first.mp4");
  const second = path.join(directory, "second.mp4");
  try {
    await writeFile(first, "identical-video-bytes");
    await writeFile(second, "identical-video-bytes");
    const firstFingerprint = await fingerprintVideo(first);
    const secondFingerprint = await fingerprintVideo(second);

    assert.match(firstFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(firstFingerprint, secondFingerprint);
  } finally {
    await rm(directory, { recursive: true });
  }
});
