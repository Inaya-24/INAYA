export class MemoryTokenStore {
  #tokens = null;

  async get() { return this.#tokens ? { ...this.#tokens } : null; }

  async set(tokens) {
    const now = Date.now();
    this.#tokens = {
      ...tokens,
      obtainedAt: now,
      accessTokenExpiresAt: tokens.expires_in ? now + Number(tokens.expires_in) * 1000 : null,
      refreshTokenExpiresAt: tokens.refresh_expires_in ? now + Number(tokens.refresh_expires_in) * 1000 : null,
    };
  }

  async clear() { this.#tokens = null; }
}
