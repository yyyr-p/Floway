ALTER TABLE users ADD COLUMN can_view_global_usage INTEGER NOT NULL DEFAULT 0 CHECK (can_view_global_usage IN (0, 1));
