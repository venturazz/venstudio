-- Approve anyway on a failed final quality check (Review, decision "override"). Additive only: two new columns on
-- style_trial_outcomes with defaults, no existing column or row changes.
--
-- qc_waived       true when the owner approved the run's final video although its quality check failed (the qc stage
--                 output has an override). Such a run never counts as a technical pass toward promotion
--                 (lib/studio/style-registry.ts trialCounts), and the Styles page shows it as waived.
-- waived_issues   the quality-check issues the owner waived, as a JSON array of strings ([] when nothing was waived).
ALTER TABLE style_trial_outcomes ADD COLUMN IF NOT EXISTS qc_waived boolean NOT NULL DEFAULT false;
ALTER TABLE style_trial_outcomes ADD COLUMN IF NOT EXISTS waived_issues jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(waived_issues) = 'array');
