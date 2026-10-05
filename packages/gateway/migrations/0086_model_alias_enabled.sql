ALTER TABLE model_aliases ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1
  CHECK (enabled IN (0, 1));
