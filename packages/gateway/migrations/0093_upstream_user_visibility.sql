ALTER TABLE upstreams ADD COLUMN user_visible INTEGER NOT NULL DEFAULT 0
  CHECK (user_visible IN (0, 1));
