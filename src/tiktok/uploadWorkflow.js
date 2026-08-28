const FINAL_STATUSES = new Set(["SEND_TO_USER_INBOX", "PUBLISH_COMPLETE", "FAILED"]);

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

export function createUploadWorkflow({
  tiktok,
  pollIntervalMs = 5_000,
  timeoutMs = 300_000,
  sleep = defaultSleep,
  now = Date.now,
  activePolls = new Map(),
} = {}) {
  if (!tiktok) throw new TypeError("A TikTok client is required.");
  requirePositiveInteger(pollIntervalMs, "pollIntervalMs");
  requirePositiveInteger(timeoutMs, "timeoutMs");
  const maxStatusChecks = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));

  async function runStatusPoll(publishId, initialStatus) {
    const deadline = now() + timeoutMs;
    let attempts = 0;
    let lastStatus = initialStatus || "PROCESSING_UPLOAD";

    while (attempts < maxStatusChecks) {
      attempts += 1;
      try {
        const response = await tiktok.getPublishStatus(publishId);
        const data = response?.data || {};
        if (typeof data.status === "string" && data.status) lastStatus = data.status;
        if (FINAL_STATUSES.has(lastStatus)) {
          return {
            outcome: lastStatus === "FAILED" ? "failed" : "complete",
            status: lastStatus,
            statusData: data,
            attempts,
          };
        }
      } catch (error) {
        if (!error?.retryable) {
          return { outcome: "error", status: lastStatus, attempts, error };
        }
      }

      const remainingMs = deadline - now();
      if (attempts >= maxStatusChecks || remainingMs <= 0) break;
      await sleep(Math.min(pollIntervalMs, remainingMs));
    }

    return { outcome: "timeout", status: lastStatus, attempts };
  }

  function pollOncePerPublishId(publishId, initialStatus) {
    const existing = activePolls.get(publishId);
    if (existing) return existing;

    const polling = runStatusPoll(publishId, initialStatus)
      .finally(() => activePolls.delete(publishId));
    activePolls.set(publishId, polling);
    return polling;
  }

  async function uploadAndWait(uploadOptions) {
    const startedAt = now();
    const upload = await tiktok.uploadVideoFile(uploadOptions);
    const publishId = upload?.publish_id;
    if (typeof publishId !== "string" || !publishId) {
      throw new TypeError("TikTok upload did not return a publish_id.");
    }

    const result = await pollOncePerPublishId(publishId, upload.status);
    return {
      publishId,
      ...result,
      elapsedMs: Math.max(0, now() - startedAt),
    };
  }

  return { uploadAndWait, maxStatusChecks };
}
