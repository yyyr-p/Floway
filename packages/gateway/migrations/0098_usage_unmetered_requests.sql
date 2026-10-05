-- Persist which request rows had no usage metrics so cost-limited admission
-- can distinguish priced and unmetered requests sharing one bucket. Older
-- metric-bearing buckets cannot reveal whether they also included requests
-- without metrics, so NULL preserves that uncertainty and remains fail-closed.
ALTER TABLE usage_requests ADD COLUMN unmetered_requests INTEGER
  CHECK (unmetered_requests IS NULL OR (unmetered_requests >= 0 AND unmetered_requests <= requests));

UPDATE usage_requests
SET unmetered_requests = requests
WHERE NOT EXISTS (
  SELECT 1 FROM usage u
  WHERE u.key_id = usage_requests.key_id
    AND u.model = usage_requests.model
    AND COALESCE(u.upstream, '') = COALESCE(usage_requests.upstream, '')
    AND u.model_key = usage_requests.model_key
    AND u.hour = usage_requests.hour
    AND u.pricing_selector = usage_requests.pricing_selector
);
