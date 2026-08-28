function mapRow(row) {
  if (!row) return null;
  return {
    fingerprint: row.video_fingerprint,
    status: row.status,
    publishId: row.publish_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    retryable: row.retryable,
    attempts: row.attempt_count,
    lastTikTokStatus: row.last_tiktok_status,
    statusChecks: row.status_check_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    leaseExpiresAt: row.lease_expires_at,
  };
}

export class PostgresVideoSubmissionStore {
  constructor({ pool }) {
    if (!pool) throw new TypeError("A PostgreSQL pool is required.");
    this.pool = pool;
  }

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS video_submissions (
        video_fingerprint CHAR(64) PRIMARY KEY,
        status TEXT NOT NULL,
        publish_id TEXT,
        error_code TEXT,
        error_message TEXT,
        retryable BOOLEAN NOT NULL DEFAULT FALSE,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        last_tiktok_status TEXT,
        status_check_count INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        lease_expires_at TIMESTAMPTZ NOT NULL
      )
    `);
    await this.pool.query(`
      ALTER TABLE video_submissions
        ADD COLUMN IF NOT EXISTS last_tiktok_status TEXT,
        ADD COLUMN IF NOT EXISTS status_check_count INTEGER
    `);
  }

  async claim(fingerprint, leaseMs) {
    const result = await this.pool.query(
      `INSERT INTO video_submissions (
         video_fingerprint, status, lease_expires_at
       ) VALUES ($1, 'PROCESSING', NOW() + $2 * INTERVAL '1 millisecond')
       ON CONFLICT (video_fingerprint) DO UPDATE SET
         status = 'PROCESSING',
         error_code = NULL,
         error_message = NULL,
         retryable = FALSE,
         attempt_count = video_submissions.attempt_count + 1,
         status_check_count = NULL,
         updated_at = NOW(),
         completed_at = NULL,
         lease_expires_at = NOW() + $2 * INTERVAL '1 millisecond'
       WHERE video_submissions.status IN ('RETRYABLE_ERROR', 'TIMED_OUT')
          OR (video_submissions.status = 'PROCESSING' AND video_submissions.lease_expires_at <= NOW())
       RETURNING *`,
      [fingerprint, leaseMs],
    );
    if (result.rows[0]) return { claimed: true, record: mapRow(result.rows[0]) };

    const existing = await this.pool.query(
      "SELECT * FROM video_submissions WHERE video_fingerprint = $1",
      [fingerprint],
    );
    return { claimed: false, record: mapRow(existing.rows[0]) };
  }

  async markUploaded(fingerprint, publishId) {
    return this.#update(
      `status = 'PROCESSING', publish_id = $2, last_tiktok_status = 'PROCESSING_UPLOAD',
       status_check_count = NULL, updated_at = NOW()`,
      [fingerprint, publishId],
    );
  }

  async markComplete(fingerprint, status, statusChecks) {
    return this.#update(
      `status = $2, last_tiktok_status = $2, status_check_count = $3,
       retryable = FALSE, updated_at = NOW(), completed_at = NOW()`,
      [fingerprint, status, statusChecks],
    );
  }

  async markFailed(fingerprint, {
    code,
    message,
    retryable = false,
    lastTikTokStatus = null,
    statusChecks = null,
  }) {
    const status = retryable ? "RETRYABLE_ERROR" : "FAILED";
    return this.#update(
      `status = $2, error_code = $3, error_message = $4, retryable = $5,
       last_tiktok_status = COALESCE($6, last_tiktok_status), status_check_count = $7,
       updated_at = NOW(), completed_at = NOW()`,
      [fingerprint, status, code, message, retryable, lastTikTokStatus, statusChecks],
    );
  }

  async markTimedOut(fingerprint, lastTikTokStatus, statusChecks) {
    return this.#update(
      `status = 'TIMED_OUT', error_code = 'status_timeout',
       error_message = 'TikTok processing did not reach a final state before the timeout.',
       retryable = TRUE, last_tiktok_status = $2, status_check_count = $3,
       updated_at = NOW(), completed_at = NOW()`,
      [fingerprint, lastTikTokStatus, statusChecks],
    );
  }

  async #update(assignments, values) {
    const result = await this.pool.query(
      `UPDATE video_submissions SET ${assignments} WHERE video_fingerprint = $1 RETURNING *`,
      values,
    );
    return mapRow(result.rows[0]);
  }
}
