-- An upstream may replace its provider mark with an operator-hosted image.
-- URL parsing and HTTPS enforcement also happen at the repository boundary.
ALTER TABLE upstreams ADD COLUMN logo_url TEXT
  CHECK (logo_url IS NULL OR (
    typeof(logo_url) = 'text'
    AND length(logo_url) <= 2048
    AND substr(logo_url, 1, 8) = 'https://'
  ));
