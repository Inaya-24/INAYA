import assert from "node:assert/strict";
import test from "node:test";
import { agentSubmissionData } from "../src/agent/submissionResponse.js";

test("agent response separates submission attempts from status checks", () => {
  const data = agentSubmissionData({
    outcome: "timeout",
    workflow: { status: "PROCESSING_UPLOAD", attempts: 56 },
    record: {
      status: "TIMED_OUT",
      publishId: "publish-1",
      lastTikTokStatus: "PROCESSING_UPLOAD",
      attempts: 1,
      statusChecks: 56,
      createdAt: "2026-08-28T12:00:00.000Z",
      updatedAt: "2026-08-28T12:05:00.000Z",
      completedAt: "2026-08-28T12:05:00.000Z",
    },
  });

  assert.equal(data.submission_attempts, 1);
  assert.equal(data.status_checks, 56);
  assert.equal(data.tiktok_status, "PROCESSING_UPLOAD");
  assert.equal("attempts" in data, false);
});
