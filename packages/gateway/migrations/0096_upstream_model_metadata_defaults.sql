-- Sparse operator fallbacks for metadata omitted by an upstream model catalog.
ALTER TABLE upstreams ADD COLUMN model_metadata_defaults_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(model_metadata_defaults_json));
