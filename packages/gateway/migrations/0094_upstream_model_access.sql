-- Existing users have no per-model restrictions; existing keys inherit the
-- user's policy. An empty rule list is the unchanged default for both.
ALTER TABLE users ADD COLUMN upstream_model_access TEXT NOT NULL DEFAULT '[]';
ALTER TABLE api_keys ADD COLUMN upstream_model_access TEXT NOT NULL DEFAULT '[]';
