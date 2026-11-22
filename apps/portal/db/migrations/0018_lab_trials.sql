-- Style system, research trials (docs/style-packs.md, "Lab trials and research styles"). Additive only: one new column
-- on style_trial_outcomes with a default, no existing column or row changes.
--
-- lab_trial   true for a lab trial: a run of a Draft or Lab pack started from Styles or a Template Lab study
--             (pipeline_runs.config.stylePack.lab). Recorded like any trial, never counted toward the pack's
--             promotion (lib/studio/style-registry.ts trialCounts), and shown apart on the Styles page.
ALTER TABLE style_trial_outcomes ADD COLUMN IF NOT EXISTS lab_trial boolean NOT NULL DEFAULT false;
