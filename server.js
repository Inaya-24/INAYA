import express from "express";

const app = express();
const PORT = process.env.PORT || 10000;
let tiktokAccessToken = null;
let tiktokRefreshToken = null;
app.get("/", (req, res) => {
  res.send("Inaya TikTok backend is running.");
});
app.get("/auth/tiktok", (req, res) => {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const redirectUri = "https://inaya.onrender.com/auth/tiktok/callback";

  const authUrl =
    "https://www.tiktok.com/v2/auth/authorize/" +
    "?client_key=" + encodeURIComponent(clientKey) +
   "&scope=user.info.basic,video.upload" +
    "&response_type=code" +
    "&redirect_uri=" + encodeURIComponent(redirectUri);

  res.redirect(authUrl);
});
app.get("/auth/tiktok/callback", async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(
      `TikTok authorization error: ${error_description || error}`
    );
  }

  if (!code) {
    return res.status(400).send("Missing TikTok authorization code.");
  }

  try {
    const params = new URLSearchParams();

    params.append("client_key", process.env.TIKTOK_CLIENT_KEY);
    params.append("client_secret", process.env.TIKTOK_CLIENT_SECRET);
    params.append("code", code);
    params.append("grant_type", "authorization_code");
    params.append(
      "redirect_uri",
      "https://inaya.onrender.com/auth/tiktok/callback"
    );

    const response = await fetch(
      "https://open.tiktokapis.com/v2/oauth/token/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params,
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("TikTok token error:", data);
      return res.status(400).json(data);
    }

    tiktokAccessToken = data.access_token;
tiktokRefreshToken = data.refresh_token;

console.log("TikTok tokens stored successfully");

    console.log("TikTok token received successfully");

    res.send("TikTok connected successfully. Access token received.");
  } catch (err) {
    console.error("TikTok token exchange error:", err);
    res.status(500).send("TikTok token exchange failed.");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Inaya backend running on port ${PORT}`);
});
