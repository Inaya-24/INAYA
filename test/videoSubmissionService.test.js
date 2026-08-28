import assert from "node:assert/strict";
import test from "node:test";
import { createVideoSubmissionService } from "../src/agent/videoSubmissionService.js";

class MemorySubmissionStore {
  constructor(record = null) {
    this.record = record;
  }

  async claim(fingerprint) {
    if (!this.record) {
      this.record = this.#record({ fingerprint, status: "PROCESSING", attempts: 1 });
      return { claimed: true, record: this.record };
    }
    if (["RETRYABLE_ERROR", "TIMED_OUT"].includes(this.record.status)
      || (this.record.status === "PROCESSING" && this.record.leaseExpired)) {
      this.record = this.#record({ ...this.record, status: "PROCESSING", attempts: this.record.attempts + 1, completedAt: null });
      return { claimed: true, record: this.record };
    }
    return { claimed: false, record: this.record };
  }

  async markUploaded(fingerprint, publishId) {
    this.record = this.#record({ ...this.record, fingerprint, publishId, status: "PROCESSING" });
    return this.record;
  }

  async markComplete(fingerprint, status) {
    this.record = this.#record({ ...this.record, fingerprint, status, retryable: false, completedAt: "2026-08-28T12:00:02.000Z" });
    return this.record;
  }

  async markFailed(fingerprint, { code, message, retryable }) {
    this.record = this.#record({
      ...this.record,
      fingerprint,
      status: retryable ? "RETRYABLE_ERROR" : "FAILED",
      errorCode: code,
      errorMessage: message,
      retryable,
      completedAt: "2026-08-28T12:00:02.000Z",
    });
    return this.record;
  }

  async markTimedOut(fingerprint) {
    this.record = this.#record({
      ...this.record,
      fingerprint,
      status: "TIMED_OUT",
      errorCode: "status_timeout",
      retryable: true,
      completedAt: "2026-08-28T12:00:02.000Z",
    });
    return this.record;
  }

  #record(values) {
    return {
      publishId: null,
      errorCode: null,
      errorMessage: null,
      retryable: false,
      createdAt: "2026-08-28T12:00:00.000Z",
      updatedAt: "2026-08-28T12:00:01.000Z",
      completedAt: null,
      ...values,
    };
  }
}

const fingerprint = async () => "a".repeat(64);

test("submits a new video through the existing upload-and-wait workflow", async () => {
  const store = new MemorySubmissionStore();
  const workflow = {
    async uploadAndWait(options, { onUploaded }) {
      assert.equal(options.filePath, "video.mp4");
      await onUploaded({ publish_id: "publish-1", status: "PROCESSING_UPLOAD" });
      return { outcome: "complete", status: "SEND_TO_USER_INBOX", attempts: 3 };
    },
  };
  const service = createVideoSubmissionService({ store, workflow, leaseMs: 1_000, fingerprint });

  const result = await service.submit({ filePath: "video.mp4" });
  assert.equal(result.outcome, "complete");
  assert.equal(result.record.publishId, "publish-1");
  assert.equal(result.record.status, "SEND_TO_USER_INBOX");
});

test("returns the stored result for duplicate video bytes without uploading", async () => {
  const existing = {
    fingerprint: "a".repeat(64),
    status: "SEND_TO_USER_INBOX",
    publishId: "publish-existing",
    attempts: 1,
    createdAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:00:01.000Z",
    completedAt: "2026-08-28T12:00:02.000Z",
  };
  const store = new MemorySubmissionStore(existing);
  const workflow = { uploadAndWait: async () => assert.fail("duplicate video was uploaded") };
  const service = createVideoSubmissionService({ store, workflow, leaseMs: 1_000, fingerprint });

  const result = await service.submit({ filePath: "same-video.mp4" });
  assert.equal(result.outcome, "duplicate");
  assert.equal(result.record.publishId, "publish-existing");
});

test("shares one active submission for concurrent requests with identical bytes", async () => {
  const store = new MemorySubmissionStore();
  let uploadCalls = 0;
  let finishUpload;
  const uploadFinished = new Promise((resolve) => { finishUpload = resolve; });
  const workflow = {
    async uploadAndWait(options, { onUploaded }) {
      uploadCalls += 1;
      await onUploaded({ publish_id: "publish-concurrent", status: "PROCESSING_UPLOAD" });
      await uploadFinished;
      return { outcome: "complete", status: "SEND_TO_USER_INBOX", attempts: 2 };
    },
  };
  const service = createVideoSubmissionService({ store, workflow, leaseMs: 1_000, fingerprint });

  const first = service.submit({ filePath: "first-copy.mp4" });
  const second = service.submit({ filePath: "second-copy.mp4" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(uploadCalls, 1);

  finishUpload();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.outcome, "complete");
  assert.equal(secondResult.outcome, "duplicate");
  assert.equal(secondResult.record.publishId, "publish-concurrent");
});

test("persists definitive upload errors", async () => {
  const store = new MemorySubmissionStore();
  const error = Object.assign(new Error("unsupported video"), { code: "invalid_video", retryable: false });
  const workflow = { uploadAndWait: async () => { throw error; } };
  const service = createVideoSubmissionService({ store, workflow, leaseMs: 1_000, fingerprint });

  const result = await service.submit({ filePath: "video.mp4" });
  assert.equal(result.outcome, "error");
  assert.equal(result.record.status, "FAILED");
  assert.equal(result.record.errorCode, "invalid_video");
  assert.equal(result.record.retryable, false);
});

test("marks retryable errors so a later trigger can reclaim the submission", async () => {
  const store = new MemorySubmissionStore();
  const error = Object.assign(new Error("temporary network failure"), { code: "network_error", retryable: true });
  const workflow = { uploadAndWait: async () => { throw error; } };
  const service = createVideoSubmissionService({ store, workflow, leaseMs: 1_000, fingerprint });

  const result = await service.submit({ filePath: "video.mp4" });
  assert.equal(result.record.status, "RETRYABLE_ERROR");
  assert.equal(result.record.retryable, true);
});

test("persists workflow timeout with its publish_id", async () => {
  const store = new MemorySubmissionStore();
  const workflow = {
    async uploadAndWait(options, { onUploaded }) {
      await onUploaded({ publish_id: "publish-timeout", status: "PROCESSING_UPLOAD" });
      return { outcome: "timeout", status: "PROCESSING_UPLOAD", attempts: 4 };
    },
  };
  const service = createVideoSubmissionService({ store, workflow, leaseMs: 1_000, fingerprint });

  const result = await service.submit({ filePath: "video.mp4" });
  assert.equal(result.outcome, "timeout");
  assert.equal(result.record.status, "TIMED_OUT");
  assert.equal(result.record.publishId, "publish-timeout");
});

test("resumes polling after a logical restart and expired lease without uploading again", async () => {
  const interrupted = {
    fingerprint: "a".repeat(64),
    status: "PROCESSING",
    publishId: "publish-resume",
    attempts: 1,
    retryable: true,
    leaseExpired: true,
    createdAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:00:01.000Z",
    completedAt: "2026-08-28T12:00:02.000Z",
  };
  const store = new MemorySubmissionStore(interrupted);
  let resumedPublishId;
  const workflow = {
    uploadAndWait: async () => assert.fail("restart caused a second upload"),
    async waitForFinalStatus(publishId) {
      resumedPublishId = publishId;
      return { outcome: "complete", status: "PUBLISH_COMPLETE", attempts: 2 };
    },
  };
  const service = createVideoSubmissionService({ store, workflow, leaseMs: 1_000, fingerprint });

  const result = await service.submit({ filePath: "video.mp4" });
  assert.equal(resumedPublishId, "publish-resume");
  assert.equal(result.record.status, "PUBLISH_COMPLETE");
  assert.equal(result.record.attempts, 2);
});
