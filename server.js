import express from "express";

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("Inaya TikTok backend is running.");
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
