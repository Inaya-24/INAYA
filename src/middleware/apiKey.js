import { timingSafeEqual } from "node:crypto";

export function requireApiKey(expectedKey) {
  return (req, res, next) => {
    if (!expectedKey) return res.status(503).json({ error: { code: "api_key_not_configured", message: "Server action routes are not configured." } });
    const suppliedKey = req.get("X-Inaya-Api-Key") || "";
    const expected = Buffer.from(expectedKey);
    const supplied = Buffer.from(suppliedKey);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      return res.status(401).json({ error: { code: "unauthorized", message: "Invalid API key." } });
    }
    next();
  };
}
