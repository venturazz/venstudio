-- Hermes director: the owner-written channel plan, per-run settings, and the review inbox.
-- See docs/architecture-autonomous-studio.md (Phase 3).

-- Written only by the owner in the channel form. Hermes reads it when it proposes ideas.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT '';

-- format, themeId, language, durationSec, styleId, purposes, topicHint. Set once when the run starts.
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}';

CREATE TABLE review_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     uuid NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  stage      text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('idea', 'approval', 'gate-failure', 'stage-error')),
  state      text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'approved', 'revision', 'rejected', 'superseded')),
  payload    jsonb NOT NULL DEFAULT '{}',
  note       text NOT NULL DEFAULT '',
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_items_open_idx ON review_items(created_at) WHERE state = 'open';
CREATE INDEX review_items_run_idx ON review_items(run_id);
-- A run has at most one open review per stage and kind, so a repeated engine pass cannot double-ask the owner.
CREATE UNIQUE INDEX review_items_open_uniq ON review_items(run_id, stage, kind) WHERE state = 'open';
