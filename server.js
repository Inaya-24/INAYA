import { randomBytes } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import multer from "multer";
import { requireApiKey } from "./src/middleware/apiKey.js";
import { TikTokClient } from "./src/tiktok/client.js";
import { publicError, TikTokApiError } from "./src/tiktok/errors.js";
import { MAX_VIDEO_SIZE } from "./src/tiktok/uploadPlan.js";
import { PostgresTokenStore } from "./src/tokens/postgresTokenStore.js";

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const redirectUri = process.env.TIKTOK_REDIRECT_URI || "https://inaya.onrender.com/auth/tiktok/callback";
const uploadDirectory = path.join(tmpdir(), "inaya-tiktok-uploads");
const configuredMaxSize = Number(process.env.MAX_VIDEO_SIZE_BYTES) || MAX_VIDEO_SIZE;
const maxVideoSize = Math.min(configuredMaxSize, MAX_VIDEO_SIZE);
const oauthStates = new Map();
const tokenStore = new PostgresTokenStore({
  connectionString: process.env.DATABASE_URL,
  encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
});
await tokenStore.initialize();
const tiktok = new TikTokClient({
  tokenStore,
  clientKey: process.env.TIKTOK_CLIENT_KEY,
  clientSecret: process.env.TIKTOK_CLIENT_SECRET,
});

await mkdir(uploadDirectory, { recursive: true });

const upload = multer({
  dest: uploadDirectory,
  limits: { files: 1, fileSize: maxVideoSize },
  fileFilter(req, file, callback) {
    const isMp4 = file.mimetype === "video/mp4" && file.originalname.toLowerCase().endsWith(".mp4");
    callback(isMp4 ? null : new TikTokApiError("Only MP4 video files are accepted.", {
      status: 415,
      code: "unsupported_media_type",
    }), isMp4);
  },
});

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

app.get("/", (req, res) => {
  res.send("Inaya TikTok backend is running.");
});

app.get("/auth/tiktok", (req, res) => {
  if (!process.env.TIKTOK_CLIENT_KEY) return res.status(503).send("TikTok client key is not configured.");
  const state = randomBytes(32).toString("base64url");
  oauthStates.set(state, Date.now() + 10 * 60 * 1000);
  const authUrl = new URL("https://www.tiktok.com/v2/auth/authorize/");
  authUrl.search = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    scope: "user.info.basic,video.upload",
    response_type: "code",
    redirect_uri: redirectUri,
    state,
  });
  res.redirect(authUrl.toString());
});

app.get("/auth/tiktok/callback", async (req, res) => {
  const { code, error, error_description: errorDescription, state } = req.query;
  if (error) return res.status(400).send(`TikTok authorization error: ${errorDescription || error}`);
  if (!code) return res.status(400).send("Missing TikTok authorization code.");
  const expiresAt = typeof state === "string" ? oauthStates.get(state) : null;
  if (!expiresAt || expiresAt < Date.now()) return res.status(400).send("Invalid or expired OAuth state. Start the TikTok connection again.");
  oauthStates.delete(state);

  try {
    await tiktok.exchangeCode({ code, redirectUri });
    console.log("TikTok tokens stored successfully");
    res.send("TikTok connected successfully. Access token received.");
  } catch (err) {
    console.error("TikTok token exchange error:", err.message);
    res.status(err.status || 500).json(publicError(err));
  }
});

app.get("/tiktok/me", async (req, res) => {
  try {
    res.json(await tiktok.getUser());
  } catch (err) {
    console.error("TikTok user info error:", err.message);
    res.status(err.status || 500).json(publicError(err));
  }
});

app.post(
  "/tiktok/videos/upload",
  requireApiKey(process.env.INAYA_API_KEY),
  upload.single("video"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: { code: "missing_video", message: "MP4 field 'video' is required." } });
    try {
      const handle = await open(req.file.path, "r");
      try {
        const signature = Buffer.alloc(8);
        await handle.read(signature, 0, 8, 0);
        if (signature.subarray(4, 8).toString("ascii") !== "ftyp") {
          throw new TikTokApiError("The uploaded file is not a valid MP4 container.", { status: 415, code: "invalid_mp4" });
        }
      } finally {
        await handle.close();
      }
      const result = await tiktok.uploadVideoFile({ filePath: req.file.path, mimeType: "video/mp4", videoSize: req.file.size });
      res.status(202).json({ data: result });
    } catch (err) {
      console.error("TikTok upload error:", err.message);
      res.status(err.status || 500).json(publicError(err));
    } finally {
      await unlink(req.file.path).catch(() => {});
    }
  },
);

app.get(
  "/tiktok/videos/:publishId/status",
  requireApiKey(process.env.INAYA_API_KEY),
  async (req, res) => {
    try {
      res.json(await tiktok.getPublishStatus(req.params.publishId));
    } catch (err) {
      console.error("TikTok publish status error:", err.message);
      res.status(err.status || 500).json(publicError(err));
    }
  },
);

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({ error: { code: err.code.toLowerCase(), message: err.message } });
  }
  console.error("Request error:", err.message);
  res.status(err.status || 500).json(publicError(err));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Inaya backend running on port ${PORT}`);
});
