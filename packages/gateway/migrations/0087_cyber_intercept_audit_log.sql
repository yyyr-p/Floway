-- Adds the cyber-intercept audit log: one row per request the gate rejected
-- (mode=reject) or drained of every flag-on candidate (mode=fallback,
-- fallback exhausted). Only rejected requests are recorded — safe verdicts
-- and non-flagged candidate sets produce no rows. hit_candidates_json is a
-- JSON array of {upstreamId, modelId}; payload_sha256 is a digest of the
-- deterministic payload serialization, never the request text itself.

CREATE TABLE cyber_intercept_audit_log (
  id                   TEXT PRIMARY KEY,
  created_at           TEXT NOT NULL,
  mode                 TEXT NOT NULL,
  action_taken         TEXT NOT NULL,
  reason               TEXT NOT NULL,
  judge_model_id       TEXT NOT NULL,
  hit_candidates_json  TEXT NOT NULL,
  payload_sha256       TEXT NOT NULL,
  request_method       TEXT NOT NULL,
  request_path         TEXT NOT NULL
);

CREATE INDEX cyber_intercept_audit_log_created_at_idx ON cyber_intercept_audit_log (created_at);