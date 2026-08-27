import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { TikTokApiError } from "./errors.js";
import { createUploadPlan } from "./uploadPlan.js";

const API_BASE = "https://open.tiktokapis.com";

async function parseJson(response) {
  try { return await response.json(); }
  catch {
    throw new TikTokApiError("TikTok returned an invalid response.", {
      status: response.status >= 400 ? response.status : 502,
      retryable: response.status >= 500,
    });
  }
}

function errorFromResponse(response, data) {
  const code = data?.error?.code;
  let status = response.status >= 400 ? response.status : 502;
  if (code === "access_token_invalid") status = 401;
  if (code === "scope_not_authorized") status = 403;
  if (code === "rate_limit_exceeded") status = 429;
  return new TikTokApiError(data?.error?.message || "TikTok API request failed.", {
    status,
    code: code || "tiktok_api_error",
    logId: data?.error?.log_id,
    retryable: response.status >= 500 || code === "internal_error" || code === "rate_limit_exceeded",
  });
}

export class TikTokClient {
  constructor({ tokenStore, clientKey, clientSecret, fetchImpl = fetch }) {
    this.tokenStore = tokenStore;
    this.clientKey = clientKey;
    this.clientSecret = clientSecret;
    this.fetch = fetchImpl;
    this.refreshPromise = null;
  }

  async exchangeCode({ code, redirectUri }) {
    const response = await this.fetch(`${API_BASE}/v2/oauth/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_key: this.clientKey, client_secret: this.clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri }),
    });
    const data = await parseJson(response);
    if (!response.ok || !data.access_token) {
      throw new TikTokApiError(data.error_description || "TikTok token exchange failed.", { status: 400, code: data.error || "token_exchange_failed" });
    }
    await this.tokenStore.set(data);
    return data;
  }

  async refreshAccessToken() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.#performRefresh().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  async #performRefresh() {
    const current = await this.tokenStore.get();
    if (!current?.refresh_token) throw new TikTokApiError("TikTok is not connected.", { status: 401, code: "tiktok_not_connected" });
    const response = await this.fetch(`${API_BASE}/v2/oauth/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_key: this.clientKey, client_secret: this.clientSecret, grant_type: "refresh_token", refresh_token: current.refresh_token }),
    });
    const data = await parseJson(response);
    if (!response.ok || !data.access_token) {
      await this.tokenStore.clear();
      throw new TikTokApiError(data.error_description || "TikTok authorization has expired.", { status: 401, code: data.error || "token_refresh_failed" });
    }
    await this.tokenStore.set(data);
    return data.access_token;
  }

  async apiRequest(path, options = {}, allowRefresh = true) {
    const tokens = await this.tokenStore.get();
    if (!tokens?.access_token) throw new TikTokApiError("TikTok is not connected.", { status: 401, code: "tiktok_not_connected" });
    const response = await this.fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        ...(options.body ? { "Content-Type": "application/json; charset=UTF-8" } : {}),
        ...options.headers,
      },
    });
    const data = await parseJson(response);
    const code = data?.error?.code;
    if (allowRefresh && (response.status === 401 || code === "access_token_invalid")) {
      await this.refreshAccessToken();
      return this.apiRequest(path, options, false);
    }
    if (!response.ok || (code && code !== "ok")) throw errorFromResponse(response, data);
    return data;
  }

  async getUser() {
    return this.apiRequest("/v2/user/info/?fields=open_id,display_name,avatar_url");
  }

  async initializeVideoUpload(videoSize) {
    const plan = createUploadPlan(videoSize);
    const result = await this.apiRequest("/v2/post/publish/inbox/video/init/", {
      method: "POST",
      body: JSON.stringify({ source_info: { source: "FILE_UPLOAD", video_size: plan.videoSize, chunk_size: plan.chunkSize, total_chunk_count: plan.totalChunkCount } }),
    });
    if (!result.data?.upload_url || !result.data?.publish_id) throw new TikTokApiError("TikTok did not return an upload URL.");
    return { ...result.data, plan };
  }

  async uploadVideoFile({ filePath, mimeType = "video/mp4", videoSize }) {
    const initialized = await this.initializeVideoUpload(videoSize);
    const uploadUrl = new URL(initialized.upload_url);
    if (uploadUrl.protocol !== "https:" || !uploadUrl.hostname.endsWith(".tiktokapis.com")) throw new TikTokApiError("TikTok returned an unsafe upload URL.");

    for (const [index, chunk] of initialized.plan.chunks.entries()) {
      const stream = createReadStream(filePath, { start: chunk.start, end: chunk.end });
      const response = await this.fetch(uploadUrl, {
        method: "PUT",
        redirect: "error",
        headers: {
          "Content-Type": mimeType,
          "Content-Length": String(chunk.length),
          "Content-Range": `bytes ${chunk.start}-${chunk.end}/${videoSize}`,
        },
        body: Readable.toWeb(stream),
        duplex: "half",
      });
      const expectedStatus = index === initialized.plan.chunks.length - 1 ? 201 : 206;
      if (response.status !== expectedStatus) {
        stream.destroy();
        await response.text().catch(() => "");
        throw new TikTokApiError(`TikTok rejected video chunk ${index + 1}/${initialized.plan.chunks.length}.`, {
          status: response.status >= 400 && response.status < 600 ? response.status : 502,
          code: "video_transfer_failed",
          retryable: response.status >= 500,
        });
      }
    }
    return {
      publish_id: initialized.publish_id,
      status: "PROCESSING_UPLOAD",
      next_step: "Open TikTok inbox when processing is complete to review and publish the draft.",
    };
  }

  async getPublishStatus(publishId) {
    return this.apiRequest("/v2/post/publish/status/fetch/", { method: "POST", body: JSON.stringify({ publish_id: publishId }) });
  }
}
