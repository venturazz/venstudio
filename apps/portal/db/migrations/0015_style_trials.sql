-- Style packs, Phase 1 (docs/style-packs.md). Additive only: one new table, no existing column or row changes.
--
-- style_trial_outcomes: the portal-side curation log. One row per run started with a Trial style pack, written by
-- lib/server/style-trials.ts after the quality check and refreshed after every decision on it: the pack version the
-- video was rendered with, the QC gates, the presentation score, the owner's final decision and the video. The Styles
-- page counts these against the promotion rule in lib/studio/templates.ts; promotion itself happens in the styles
-- repo by PR. pipeline_runs.config.stylePack ({ id, version, status, trial }) marks such a run; it is additive JSON.
CREATE TABLE IF NOT EXISTS style_trial_outcomes (
  run_id             uuid PRIMARY KEY REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  pack_id            text NOT NULL CHECK (pack_id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  pack_version       text NOT NULL CHECK (pack_version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$'),
  -- G-technical: the gate every trial must pass. NULL never stored: a row is written once QC ran.
  qc_passed          boolean NOT NULL,
  -- [{ gate, passed, score }], the latest report per gate.
  qc_gates           jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(qc_gates) = 'array'),
  presentation_score int CHECK (presentation_score BETWEEN 0 AND 100),
  owner_decision     text CHECK (owner_decision IN ('approved', 'rejected', 'revised', 'auto-approved')),
  decided_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at         timestamptz,
  video_asset_id     uuid REFERENCES assets(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS style_trial_outcomes_pack_idx ON style_trial_outcomes(pack_id, pack_version, created_at DESC);
