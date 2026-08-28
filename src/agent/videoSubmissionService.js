import { fingerprintVideo } from "./videoFingerprint.js";

export function createVideoSubmissionService({
  store,
  workflow,
  leaseMs,
  fingerprint = fingerprintVideo,
  activeSubmissions = new Map(),
}) {
  if (!store || !workflow) throw new TypeError("A submission store and TikTok workflow are required.");
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new TypeError("leaseMs must be a positive integer.");

  async function runSubmission(videoFingerprint, uploadOptions) {
    const claim = await store.claim(videoFingerprint, leaseMs);
    if (!claim.claimed) return { outcome: "duplicate", record: claim.record };

    let record = claim.record;
    try {
      const result = record.publishId
        ? await workflow.waitForFinalStatus(record.publishId, "PROCESSING_UPLOAD")
        : await workflow.uploadAndWait(uploadOptions, {
          async onUploaded(upload) {
            record = await store.markUploaded(videoFingerprint, upload.publish_id);
          },
        });

      if (result.outcome === "complete") {
        record = await store.markComplete(videoFingerprint, result.status);
        return { outcome: "complete", record, workflow: result };
      }
      if (result.outcome === "failed") {
        const failReason = result.statusData?.fail_reason;
        record = await store.markFailed(videoFingerprint, {
          code: "tiktok_publish_failed",
          message: failReason || "TikTok could not process the uploaded video.",
          retryable: false,
        });
        return { outcome: "failed", record, workflow: result, failReason };
      }
      if (result.outcome === "timeout") {
        record = await store.markTimedOut(videoFingerprint);
        return { outcome: "timeout", record, workflow: result };
      }

      const error = result.error;
      record = await store.markFailed(videoFingerprint, {
        code: error?.code || "tiktok_status_error",
        message: error?.message || "TikTok status check failed.",
        retryable: Boolean(error?.retryable),
      });
      return { outcome: "error", record, workflow: result, error };
    } catch (error) {
      record = await store.markFailed(videoFingerprint, {
        code: error?.code || "tiktok_upload_error",
        message: error?.message || "TikTok upload failed.",
        retryable: Boolean(error?.retryable),
      });
      return { outcome: "error", record, error };
    }
  }

  async function submit(uploadOptions) {
    const videoFingerprint = await fingerprint(uploadOptions.filePath);
    const existing = activeSubmissions.get(videoFingerprint);
    if (existing) {
      const result = await existing;
      return { outcome: "duplicate", record: result.record };
    }

    const submission = runSubmission(videoFingerprint, uploadOptions)
      .finally(() => activeSubmissions.delete(videoFingerprint));
    activeSubmissions.set(videoFingerprint, submission);
    return submission;
  }

  return { submit };
}
