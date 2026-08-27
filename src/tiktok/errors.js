export class TikTokApiError extends Error {
  constructor(message, { status = 502, code = "tiktok_api_error", logId, retryable = false } = {}) {
    super(message);
    this.name = "TikTokApiError";
    this.status = status;
    this.code = code;
    this.logId = logId;
    this.retryable = retryable;
  }
}

export function publicError(error) {
  if (error instanceof TikTokApiError) {
    return { error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.logId ? { log_id: error.logId } : {}),
    } };
  }
  return { error: { code: "internal_error", message: "An unexpected server error occurred.", retryable: false } };
}
