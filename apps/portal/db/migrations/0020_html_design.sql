-- html-design (docs/style-packs.md "html-design"; lib/studio/recipes.ts) and the still-frame preview. Additive only.
--
-- pipeline_stages.stage gets two kinds: 'html-design' (the page Hermes writes for a run, research only) and 'preview'
-- (still frames of an html-capture page before the voice and the render, worker job preview-frames). assets.kind gets
-- 'html-page': the page bundle of an html-design run (application/json, provenance source hermes, research only).
-- Every name either CHECK allowed stays allowed; no row and no other column changes.
--
-- As in 0012 and 0019, every CHECK on the column is dropped by its definition rather than an assumed name, so a
-- differently named constraint cannot survive and keep refusing the new names while the migration reports success.

DO $$
DECLARE
  con record;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'pipeline_stages'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ~* '\mstage\M'
  LOOP
    EXECUTE format('ALTER TABLE pipeline_stages DROP CONSTRAINT %I', con.conname);
  END LOOP;
  FOR con IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'assets'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ~* '\mkind\M'
  LOOP
    EXECUTE format('ALTER TABLE assets DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

ALTER TABLE pipeline_stages ADD CONSTRAINT pipeline_stages_stage_check
  CHECK (stage IN ('idea', 'research', 'script', 'storyboard', 'scene-spec', 'skill-brief', 'html-design', 'preview', 'assets',
                   'voice', 'draft', 'render', 'qc', 'approval', 'upload', 'claim-watch', 'publish', 'learn'));

ALTER TABLE assets ADD CONSTRAINT assets_kind_check
  CHECK (kind IN ('video', 'reference-video', 'image', 'audio', 'font', 'sprite-sheet', 'model-3d', 'script', 'other', 'html-page'));
