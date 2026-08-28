import assert from "node:assert/strict";
import test from "node:test";
import { createUploadWorkflow } from "../src/tiktok/uploadWorkflow.js";

function createHarness(statusResults, options = {}) {
  let currentTime = 0;
  const sleeps = [];
  const calls = { upload: 0, status: 0 };
  const queue = [...statusResults];
  const tiktok = {
    async uploadVideoFile() {
      calls.upload += 1;
      return { publish_id: options.publishId || "publish-1", status: "PROCESSING_UPLOAD" };
    },
    async getPublishStatus() {
      calls.status += 1;
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const workflow = createUploadWorkflow({
    tiktok,
    pollIntervalMs: options.pollIntervalMs || 100,
    timeoutMs: options.timeoutMs || 1_000,
    now: () => currentTime,
    async sleep(delayMs) {
      sleeps.push(delayMs);
      currentTime += delayMs;
    },
  });
  return { workflow, calls, sleeps };
}

test("uploads and polls until the draft reaches the TikTok inbox", async () => {
  const harness = createHarness([
    { data: { status: "PROCESSING_UPLOAD", uploaded_bytes: 10 } },
    { data: { status: "SEND_TO_USER_INBOX" } },
  ]);

  const result = await harness.workflow.uploadAndWait({ filePath: "video.mp4", videoSize: 10 });

  assert.equal(result.publishId, "publish-1");
  assert.equal(result.outcome, "complete");
  assert.equal(result.status, "SEND_TO_USER_INBOX");
  assert.equal(result.attempts, 2);
  assert.deepEqual(harness.sleeps, [100]);
});

test("treats PUBLISH_COMPLETE as a successful final status", async () => {
  const harness = createHarness([{ data: { status: "PUBLISH_COMPLETE" } }]);
  const result = await harness.workflow.uploadAndWait({});

  assert.equal(result.outcome, "complete");
  assert.equal(result.status, "PUBLISH_COMPLETE");
  assert.equal(result.attempts, 1);
});

test("returns TikTok failure details for FAILED", async () => {
  const harness = createHarness([{ data: { status: "FAILED", fail_reason: "duration_check_failed" } }]);
  const result = await harness.workflow.uploadAndWait({});

  assert.equal(result.outcome, "failed");
  assert.equal(result.status, "FAILED");
  assert.equal(result.statusData.fail_reason, "duration_check_failed");
});

test("caps status checks consistently with timeout and interval", async () => {
  const harness = createHarness([
    { data: { status: "PROCESSING_UPLOAD" } },
    { data: { status: "PROCESSING_UPLOAD" } },
    { data: { status: "PROCESSING_UPLOAD" } },
  ], { pollIntervalMs: 100, timeoutMs: 250 });

  assert.equal(harness.workflow.maxStatusChecks, 3);
  const result = await harness.workflow.uploadAndWait({});
  assert.equal(result.outcome, "timeout");
  assert.equal(result.status, "PROCESSING_UPLOAD");
  assert.equal(result.attempts, 3);
  assert.equal(harness.calls.status, 3);
  assert.deepEqual(harness.sleeps, [100, 100]);
});

test("retries retryable status errors at the configured interval", async () => {
  const retryableError = Object.assign(new Error("temporary TikTok failure"), { retryable: true });
  const harness = createHarness([
    retryableError,
    { data: { status: "SEND_TO_USER_INBOX" } },
  ]);

  const result = await harness.workflow.uploadAndWait({});
  assert.equal(result.outcome, "complete");
  assert.equal(result.attempts, 2);
  assert.deepEqual(harness.sleeps, [100]);
});

test("stops immediately on a non-retryable status error", async () => {
  const fatalError = Object.assign(new Error("invalid publish id"), { status: 400, retryable: false });
  const harness = createHarness([fatalError]);

  const result = await harness.workflow.uploadAndWait({});
  assert.equal(result.outcome, "error");
  assert.equal(result.error, fatalError);
  assert.equal(result.attempts, 1);
  assert.deepEqual(harness.sleeps, []);
});

test("rejects an upload response without a publish_id", async () => {
  const workflow = createUploadWorkflow({
    tiktok: {
      uploadVideoFile: async () => ({ status: "PROCESSING_UPLOAD" }),
      getPublishStatus: async () => ({ data: { status: "SEND_TO_USER_INBOX" } }),
    },
  });

  await assert.rejects(() => workflow.uploadAndWait({}), /publish_id/);
});

test("shares one status loop for concurrent workflows with the same publish_id", async () => {
  let resolveStatus;
  let statusCalls = 0;
  const statusResponse = new Promise((resolve) => { resolveStatus = resolve; });
  const workflow = createUploadWorkflow({
    tiktok: {
      uploadVideoFile: async () => ({ publish_id: "shared-publish", status: "PROCESSING_UPLOAD" }),
      async getPublishStatus() {
        statusCalls += 1;
        return statusResponse;
      },
    },
    pollIntervalMs: 100,
    timeoutMs: 1_000,
  });

  const first = workflow.uploadAndWait({ filePath: "first.mp4" });
  const second = workflow.uploadAndWait({ filePath: "second.mp4" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(statusCalls, 1);

  resolveStatus({ data: { status: "SEND_TO_USER_INBOX" } });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, "SEND_TO_USER_INBOX");
  assert.equal(secondResult.status, "SEND_TO_USER_INBOX");
  assert.equal(statusCalls, 1);
});

test("validates polling configuration", () => {
  const tiktok = {};
  assert.throws(() => createUploadWorkflow({ tiktok, pollIntervalMs: 0 }), /pollIntervalMs/);
  assert.throws(() => createUploadWorkflow({ tiktok, timeoutMs: -1 }), /timeoutMs/);
});
