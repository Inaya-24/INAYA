export function parseVideoListPagination(query = {}) {
  const cursor = query.cursor === undefined ? undefined : Number(query.cursor);
  const maxCount = query.max_count === undefined ? 20 : Number(query.max_count);
  if ((cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0))
    || !Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > 20) return null;
  return { cursor, maxCount };
}

export function videoListPublicError(error) {
  if (error?.status === 403) return { status: 403, error: { code: "tiktok_video_list_scope_required", message: "TikTok permission video.list is required.", retryable: false } };
  if (error?.status === 401) return { status: 401, error: { code: "tiktok_reconnect_required", message: "TikTok must be reconnected.", retryable: false } };
  if (error?.status === 429) return { status: 429, error: { code: "tiktok_rate_limited", message: "TikTok rate limit reached. Try again later.", retryable: true } };
  return { status: error?.status >= 500 ? 503 : 502, error: { code: "tiktok_video_list_failed", message: "TikTok videos are temporarily unavailable.", retryable: true } };
}

export function createVideoListHandler(tiktok, { logger = console } = {}) {
  return async (req, res) => {
    const pagination = parseVideoListPagination(req.query);
    if (!pagination) return res.status(400).json({ error: { code: "invalid_pagination", message: "Pagination parameters are invalid.", retryable: false } });
    try {
      return res.json({ data: await tiktok.listVideos(pagination) });
    } catch (error) {
      logger.error("TikTok video list request failed.");
      const result = videoListPublicError(error);
      return res.status(result.status).json({ error: result.error });
    }
  };
}
