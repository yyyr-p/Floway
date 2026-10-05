CREATE TABLE usage_limits (
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'key')),
  principal_id TEXT NOT NULL,
  window TEXT NOT NULL CHECK (window IN ('hour', 'day', 'month')),
  max_tokens INTEGER CHECK (max_tokens IS NULL OR max_tokens >= 0),
  max_cost_micros INTEGER CHECK (max_cost_micros IS NULL OR max_cost_micros >= 0),
  PRIMARY KEY (principal_type, principal_id, window),
  CHECK (max_tokens IS NOT NULL OR max_cost_micros IS NOT NULL)
);

CREATE TABLE usage_limit_reservations (
  reservation_id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'key')),
  principal_id TEXT NOT NULL,
  window TEXT NOT NULL CHECK (window IN ('hour', 'day', 'month')),
  window_start TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  tokens INTEGER NOT NULL CHECK (tokens >= 0),
  cost_micros INTEGER NOT NULL CHECK (cost_micros >= 0),
  PRIMARY KEY (reservation_id, principal_type, principal_id, window)
);
CREATE INDEX idx_usage_limit_reservations_scope
  ON usage_limit_reservations (principal_type, principal_id, window, window_start, expires_at);
