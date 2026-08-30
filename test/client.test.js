import assert from "node:assert/strict";
import test from "node:test";
import { TikTokClient } from "../src/tiktok/client.js";
import { MemoryTokenStore } from "../src/tokens/memoryTokenStore.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("API requests refresh an expired access token once", async () => {
  const store = new MemoryTokenStore();
  await store.set({ access_token: "expired", refresh_token: "refresh", expires_in: 3600 });
  const calls = [];
  const client = new TikTokClient({
    tokenStore: store,
    clientKey: "key",
    clientSecret: "secret",
    async fetchImpl(url, options) {
      calls.push({ url: String(url), authorization: options.headers?.Authorization });
      if (String(url).endsWith("/oauth/token/")) return jsonResponse({ access_token: "fresh", refresh_token: "new-refresh", expires_in: 3600 });
      if (options.headers.Authorization === "Bearer expired") return jsonResponse({ error: { code: "access_token_invalid", message: "expired" } }, 401);
      return jsonResponse({ data: { user: { display_name: "Inaya" } }, error: { code: "ok", message: "" } });
    },
  });

  const result = await client.getUser();
  assert.equal(result.data.user.display_name, "Inaya");
  assert.equal(calls.length, 3);
  assert.equal(calls[2].authorization, "Bearer fresh");
});

test("TikTok errors retain safe structured metadata", async () => {
  const store = new MemoryTokenStore();
  await store.set({ access_token: "valid", refresh_token: "refresh" });
  const client = new TikTokClient({
    tokenStore: store,
    clientKey: "key",
    clientSecret: "secret",
    fetchImpl: async () => jsonResponse({ error: { code: "rate_limit_exceeded", message: "slow down", log_id: "log-1" } }, 429),
  });

  await assert.rejects(client.getPublishStatus("publish-1"), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.code, "rate_limit_exceeded");
    assert.equal(error.logId, "log-1");
    assert.equal(error.retryable, true);
    return true;
  });
});

test("lists official TikTok videos with metrics and pagination", async () => {
  const store = new MemoryTokenStore();
  await store.set({ access_token: "valid", refresh_token: "refresh", scope: "user.info.basic,video.upload,video.list" });
  let request;
  const client = new TikTokClient({ tokenStore: store, clientKey: "key", clientSecret: "secret", async fetchImpl(url, options) {
    request = { url: String(url), options };
    return jsonResponse({ data: { videos: [{ id: "video-1", create_time: 1700000000, title: "Title", video_description: "Caption", duration: 12, share_url: "https://www.tiktok.com/video/1", view_count: 100, like_count: 12, comment_count: 3, share_count: 2 }], cursor: 1699999999000, has_more: true }, error: { code: "ok", message: "" } });
  } });

  const result = await client.listVideos({ cursor: 1700000000000, maxCount: 20 });
  assert.match(request.url, /^https:\/\/open\.tiktokapis\.com\/v2\/video\/list\/\?fields=/);
  assert.deepEqual(JSON.parse(request.options.body), { cursor: 1700000000000, max_count: 20 });
  assert.equal(result.videos[0].view_count, 100);
  assert.equal(result.videos[0].comment_count, 3);
  assert.equal(result.cursor, 1699999999000);
  assert.equal(result.has_more, true);
});

test("video listing refreshes an expired token and retries once", async () => {
  const store = new MemoryTokenStore();
  await store.set({ access_token: "expired", refresh_token: "refresh" });
  let listCalls = 0;
  const client = new TikTokClient({ tokenStore: store, clientKey: "key", clientSecret: "secret", async fetchImpl(url, options) {
    if (String(url).endsWith("/oauth/token/")) return jsonResponse({ access_token: "fresh", refresh_token: "new-refresh", expires_in: 3600 });
    listCalls += 1;
    if (options.headers.Authorization === "Bearer expired") return jsonResponse({ error: { code: "access_token_invalid", message: "expired" } }, 401);
    return jsonResponse({ data: { videos: [], cursor: 0, has_more: false }, error: { code: "ok", message: "" } });
  } });

  const result = await client.listVideos();
  assert.equal(listCalls, 2);
  assert.deepEqual(result.videos, []);
});

test("video listing preserves missing metrics as null and rejects missing scope", async () => {
  const store = new MemoryTokenStore();
  await store.set({ access_token: "valid", refresh_token: "refresh" });
  const partialClient = new TikTokClient({ tokenStore: store, clientKey: "key", clientSecret: "secret", fetchImpl: async () => jsonResponse({ data: { videos: [{ id: "partial" }], has_more: false }, error: { code: "ok", message: "" } }) });
  const result = await partialClient.listVideos();
  assert.equal(result.videos[0].view_count, null);
  assert.equal(result.videos[0].duration, null);

  const deniedClient = new TikTokClient({ tokenStore: store, clientKey: "key", clientSecret: "secret", fetchImpl: async () => jsonResponse({ error: { code: "scope_not_authorized", message: "permission required" } }, 403) });
  await assert.rejects(deniedClient.listVideos(), (error) => error.status === 403 && error.code === "scope_not_authorized");
});
