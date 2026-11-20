-- Video generation becomes a real asset path, not just a plan.
-- See docs/research/05-hermes-asset-bridge.md and hermes/README.md.
--
-- Both CHECKs below predate video. In 0009 asset_providers knew image/tts/library, and in 0011 endpoint_health
-- knew image/tts. A video provider or a video health row would therefore have failed on the constraint at
-- runtime, in the middle of a job, with nothing in the type system to warn about it: the TS unions said
-- "image" | "tts" and so did the database, so the mismatch only surfaced on the first real video asset.
--
-- Widening a CHECK is the whole change; no column changes and no data is touched.

ALTER TABLE asset_providers DROP CONSTRAINT IF EXISTS asset_providers_kind_check;
ALTER TABLE asset_providers ADD CONSTRAINT asset_providers_kind_check
  CHECK (kind IN ('image', 'tts', 'library', 'video'));

ALTER TABLE endpoint_health DROP CONSTRAINT IF EXISTS endpoint_health_kind_check;
ALTER TABLE endpoint_health ADD CONSTRAINT endpoint_health_kind_check
  CHECK (kind IN ('image', 'tts', 'video'));
