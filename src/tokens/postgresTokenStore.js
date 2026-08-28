import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TOKEN_ROW_ID = 1;
const AAD = Buffer.from("inaya:tiktok-tokens:v1", "utf8");

function decodeEncryptionKey(value) {
  if (!value) throw new Error("TOKEN_ENCRYPTION_KEY is required.");
  const normalizedValue = value.trim();
  const key = /^[0-9a-f]{64}$/i.test(normalizedValue)
    ? Buffer.from(normalizedValue, "hex")
    : Buffer.from(normalizedValue.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must encode exactly 32 bytes.");
  return key;
}

function encryptTokens(tokens, key, randomBytesImpl) {
  const iv = randomBytesImpl(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptTokens(row, key) {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(row.iv, "base64"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

export class PostgresTokenStore {
  constructor({ connectionString, encryptionKey, pool, randomBytesImpl = randomBytes } = {}) {
    if (!connectionString && !pool) throw new Error("DATABASE_URL is required.");
    this.key = decodeEncryptionKey(encryptionKey);
    this.pool = pool || new Pool({
      connectionString,
      ssl: { rejectUnauthorized: true },
      max: 2,
    });
    this.pool.on("error", (error) => {
      console.error("PostgreSQL idle connection error:", error?.message || "Unknown connection error.");
    });
    this.randomBytes = randomBytesImpl;
  }

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tiktok_tokens (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async get() {
    const result = await this.pool.query(
      "SELECT ciphertext, iv, auth_tag FROM tiktok_tokens WHERE id = $1",
      [TOKEN_ROW_ID],
    );
    if (!result.rows[0]) return null;
    return decryptTokens(result.rows[0], this.key);
  }

  async set(tokens) {
    const now = Date.now();
    const encrypted = encryptTokens({
      ...tokens,
      obtainedAt: now,
      accessTokenExpiresAt: tokens.expires_in ? now + Number(tokens.expires_in) * 1000 : null,
      refreshTokenExpiresAt: tokens.refresh_expires_in ? now + Number(tokens.refresh_expires_in) * 1000 : null,
    }, this.key, this.randomBytes);
    await this.pool.query(
      `INSERT INTO tiktok_tokens (id, ciphertext, iv, auth_tag, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         updated_at = NOW()`,
      [TOKEN_ROW_ID, encrypted.ciphertext, encrypted.iv, encrypted.authTag],
    );
  }

  async clear() {
    await this.pool.query("DELETE FROM tiktok_tokens WHERE id = $1", [TOKEN_ROW_ID]);
  }
}
