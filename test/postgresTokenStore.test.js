import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { PostgresTokenStore } from "../src/tokens/postgresTokenStore.js";

class FakePool {
  constructor() { this.row = null; }

  async query(sql, values = []) {
    if (sql.includes("CREATE TABLE")) return { rows: [] };
    if (sql.startsWith("SELECT")) return { rows: this.row ? [this.row] : [] };
    if (sql.startsWith("INSERT")) {
      this.row = { ciphertext: values[1], iv: values[2], auth_tag: values[3] };
      return { rows: [] };
    }
    if (sql.startsWith("DELETE")) {
      this.row = null;
      return { rows: [] };
    }
    throw new Error("Unexpected query in test.");
  }
}

test("persists and decrypts TikTok tokens without storing plaintext", async () => {
  const pool = new FakePool();
  const store = new PostgresTokenStore({
    pool,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  const tokens = {
    access_token: "access-token-for-test",
    refresh_token: "refresh-token-for-test",
    expires_in: 3600,
    refresh_expires_in: 86400,
  };

  await store.initialize();
  assert.equal(await store.get(), null);
  await store.set(tokens);
  assert.ok(!JSON.stringify(pool.row).includes(tokens.access_token));
  assert.ok(!JSON.stringify(pool.row).includes(tokens.refresh_token));

  const restored = await store.get();
  assert.equal(restored.access_token, tokens.access_token);
  assert.equal(restored.refresh_token, tokens.refresh_token);
  assert.ok(restored.accessTokenExpiresAt > restored.obtainedAt);
  assert.ok(restored.refreshTokenExpiresAt > restored.obtainedAt);

  await store.clear();
  assert.equal(await store.get(), null);
});

test("rejects missing and invalid encryption keys", () => {
  const pool = new FakePool();
  assert.throws(() => new PostgresTokenStore({ pool }), /TOKEN_ENCRYPTION_KEY/);
  assert.throws(
    () => new PostgresTokenStore({ pool, encryptionKey: "too-short" }),
    /exactly 32 bytes/,
  );
});

test("accepts a 64-character hexadecimal key representing exactly 32 bytes", async () => {
  const pool = new FakePool();
  const hexKey = "ab".repeat(32);
  const store = new PostgresTokenStore({ pool, encryptionKey: hexKey });

  await store.set({ access_token: "access-token-for-test" });
  assert.equal((await store.get()).access_token, "access-token-for-test");
});

test("normalizes surrounding whitespace on a 64-character hexadecimal key", async () => {
  const pool = new FakePool();
  const hexKey = "cd".repeat(32);
  const store = new PostgresTokenStore({ pool, encryptionKey: `\n${hexKey}\r\n` });

  await store.set({ access_token: "access-token-for-test" });
  assert.equal((await store.get()).access_token, "access-token-for-test");
});

test("detects encrypted token tampering", async () => {
  const pool = new FakePool();
  const store = new PostgresTokenStore({
    pool,
    encryptionKey: randomBytes(32).toString("hex"),
  });
  await store.set({ access_token: "access-token-for-test" });
  pool.row.ciphertext = `${pool.row.ciphertext.slice(0, -2)}AA`;
  await assert.rejects(() => store.get());
});
