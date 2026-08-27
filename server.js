import express from "express";

const app = express();
const PORT = process.env.PORT || 10000;

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
app.get("/auth/tiktok/callback", (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(
      `TikTok authorization error: ${error_description || error}`
    );
  }

  if (!code) {
    return res.status(400).send("Missing TikTok authorization code.");
  }

  res.send(
    "TikTok authorization received successfully. You can close this page."
  );
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Inaya backend running on port ${PORT}`);
});
