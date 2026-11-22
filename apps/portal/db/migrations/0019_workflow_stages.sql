-- Workflows (docs/style-packs.md, "Workflows"; lib/studio/recipes.ts). A run's stage list now comes from its style
-- pack's recipe and is stored in pipeline_runs.config.workflow (jsonb, no schema change). Two new stage kinds stand
-- where the storyboard stands in a workflow without pictures: 'scene-spec' (a data-driven page's scene spec) and
-- 'skill-brief' (the input a Hermes skill renders from). pipeline_stages.stage has a CHECK from 0007 that lists the
-- stage names, so it is widened here. Every name it allowed stays allowed; no row and no other column changes.
--
-- As in 0012, every CHECK on the column is dropped by its definition rather than an assumed name, so a differently
-- named constraint cannot survive and keep refusing the new names while the migration reports success.

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
END $$;

ALTER TABLE pipeline_stages ADD CONSTRAINT pipeline_stages_stage_check
  CHECK (stage IN ('idea', 'research', 'script', 'storyboard', 'scene-spec', 'skill-brief', 'assets', 'voice', 'draft',
                   'render', 'qc', 'approval', 'upload', 'claim-watch', 'publish', 'learn'));
