-- Adds the operator-owned server-wide settings KV store. One row per
-- setting key, value_json holding the setting's JSON document verbatim.
-- Value shape and validation belong to the control-plane schemas that own
-- each key; the repo stores and returns the parsed document untouched.

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
