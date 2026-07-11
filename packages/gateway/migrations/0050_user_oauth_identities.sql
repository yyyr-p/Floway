CREATE TABLE user_oauth_identities (
  user_id     INTEGER NOT NULL,
  provider_id TEXT NOT NULL,
  subject     TEXT NOT NULL,
  email       TEXT,
  linked_at   TEXT NOT NULL,
  PRIMARY KEY (provider_id, subject)
);
CREATE INDEX idx_user_oauth_identities_user ON user_oauth_identities(user_id);
