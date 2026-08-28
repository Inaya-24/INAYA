# INAYA
Official website for Inaya TikTok integration

## TikTok video upload workflow

`POST /tiktok/videos/upload-and-wait` accepts the same authenticated `multipart/form-data`
request as `POST /tiktok/videos/upload`, with an MP4 file in the `video` field. It uploads
the file, polls TikTok for its status, and returns when TikTok reports
`SEND_TO_USER_INBOX`, `PUBLISH_COMPLETE`, or `FAILED`, or when the configured timeout is
reached.

Successful responses include `data.publish_id`, `data.status`, `data.attempts`, and
`data.elapsed_ms`. TikTok failures and polling timeouts also include a structured `error`
object. `TIKTOK_STATUS_POLL_INTERVAL_MS` defaults to 5000 milliseconds and
`TIKTOK_STATUS_TIMEOUT_MS` defaults to 300000 milliseconds.
