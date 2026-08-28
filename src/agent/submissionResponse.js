export function agentSubmissionData(result) {
  const { record } = result;
  return {
    status: record.status,
    publish_id: record.publishId || null,
    tiktok_status: record.lastTikTokStatus || result.workflow?.status || null,
    duplicate: result.outcome === "duplicate",
    submission_attempts: record.attempts,
    status_checks: record.statusChecks ?? result.workflow?.attempts ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    completed_at: record.completedAt || null,
  };
}
