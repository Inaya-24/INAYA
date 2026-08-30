import assert from "node:assert/strict";
import test from "node:test";
import { createVideoListHandler, parseVideoListPagination, videoListPublicError } from "../src/tiktok/videoListRoute.js";

function responseRecorder() {
  return { statusCode: 200, body: null, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
}

test("validates and bounds video list pagination", () => {
  assert.deepEqual(parseVideoListPagination({}), { cursor: undefined, maxCount: 20 });
  assert.deepEqual(parseVideoListPagination({ cursor: "1646883959000", max_count: "10" }), { cursor: 1646883959000, maxCount: 10 });
  assert.equal(parseVideoListPagination({ cursor: "bad" }), null);
  assert.equal(parseVideoListPagination({ max_count: "21" }), null);
});

test("endpoint forwards stable pagination and returns the JARVIS contract", async () => {
  let received;
  const handler = createVideoListHandler({ async listVideos(options) { received = options; return { videos: [], cursor: null, has_more: false }; } });
  const response = responseRecorder();
  await handler({ query: { cursor: "1000", max_count: "20" } }, response);
  assert.deepEqual(received, { cursor: 1000, maxCount: 20 });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { data: { videos: [], cursor: null, has_more: false } });
});

test("endpoint exposes a stable missing-scope error without leaking upstream data", async () => {
  const sensitive = Object.assign(new Error("upstream details access-token-value"), { status: 403, code: "scope_not_authorized" });
  const logs = [];
  const handler = createVideoListHandler({ async listVideos() { throw sensitive; } }, { logger: { error: (message) => logs.push(message) } });
  const response = responseRecorder();
  await handler({ query: {} }, response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error.code, "tiktok_video_list_scope_required");
  assert.doesNotMatch(JSON.stringify(response.body), /access-token-value|scope_not_authorized/);
  assert.deepEqual(logs, ["TikTok video list request failed."]);
});

test("maps reconnect, rate-limit and temporary failures distinctly", () => {
  assert.equal(videoListPublicError({ status: 401 }).error.code, "tiktok_reconnect_required");
  assert.equal(videoListPublicError({ status: 429 }).error.code, "tiktok_rate_limited");
  assert.equal(videoListPublicError({ status: 500 }).status, 503);
});
