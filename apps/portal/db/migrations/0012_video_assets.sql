-- Video generation becomes a real asset path, not just a plan.
-- See docs/research/05-hermes-asset-bridge.md and hermes/README.md.
--
-- Both CHECKs below predate video. In 0009 asset_providers knew image/tts/library, and in 0011 endpoint_health
-- knew image/tts. A video provider or a video health row would therefore have failed on the constraint at
-- runtime, in the middle of a job, with nothing in the type system to warn about it: the TS unions said
-- "image" | "tts" and so did the database, so the mismatch only surfaced on the first real video asset.
--
-- The drop matches on the constraint definition rather than on an assumed name, for a reason worth stating.
-- `DROP CONSTRAINT IF EXISTS asset_providers_kind_check` follows the convention 0002 relies on, but if the name
-- ever differs it matches nothing and still reports success. The ADD below would then run anyway and create a
-- *second* CHECK while the original, narrower one went on rejecting 'video': a migration that succeeds and
-- changes nothing, which is worse than one that fails loudly. So every CHECK on the column goes first,
-- whatever it is called. No column changes and no data is touched.

DO $$
DECLARE
  tbl text;
  con record;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['asset_providers', 'endpoint_health'] LOOP
    FOR con IN
      SELECT conname FROM pg_constraint
       WHERE conrelid = tbl::regclass
         AND contype = 'c'
         AND (conname LIKE '%kind%' OR pg_get_constraintdef(oid) ~* '\mkind\M')
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', tbl, con.conname);
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE asset_providers ADD CONSTRAINT asset_providers_kind_check
  CHECK (kind IN ('image', 'tts', 'library', 'video'));

ALTER TABLE endpoint_health ADD CONSTRAINT endpoint_health_kind_check
  CHECK (kind IN ('image', 'tts', 'video'));
