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
