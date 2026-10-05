ALTER TABLE model_aliases ADD COLUMN fallback_policy TEXT NOT NULL DEFAULT 'configured'
  CHECK (fallback_policy IN ('configured', 'preserve-opaque'));
ALTER TABLE responses_snapshots ADD COLUMN route_json TEXT;
CREATE TABLE conversation_routes (
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  route_json TEXT NOT NULL,
  PRIMARY KEY (api_key_id, session_id, scope)
);
