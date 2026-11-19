-- Autonomous studio: final templates, trial evidence, pipeline runs and stages, work orders, QC reports,
-- and per-channel autonomy. See docs/architecture-autonomous-studio.md section 3.
-- Template ids are text (for example "tpl-explainer-stills") so seeds are stable across installs.

CREATE TABLE templates (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'candidate' CHECK (status IN ('draft', 'candidate', 'proven', 'retired')),
  style_id        text NOT NULL,
  current_version int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One row per version. spec holds the whole template document (beats, pacing, audio, evidence, checklist).
CREATE TABLE template_versions (
  template_id text NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  version     int NOT NULL,
  spec        jsonb NOT NULL,
  checklist   jsonb NOT NULL DEFAULT '[]',
  signed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  signed_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, version)
);

CREATE TABLE pipeline_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id       uuid REFERENCES channels(id) ON DELETE SET NULL,
  production_id    uuid REFERENCES productions(id) ON DELETE SET NULL,
  template_id      text REFERENCES templates(id) ON DELETE SET NULL,
  template_version int,
  topic            text NOT NULL DEFAULT '',
  state            text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'waiting-human', 'failed', 'done', 'cancelled')),
  autonomy_level   smallint NOT NULL DEFAULT 1 CHECK (autonomy_level BETWEEN 0 AND 3),
  kind             text NOT NULL DEFAULT 'production' CHECK (kind IN ('production', 'lab')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);
CREATE INDEX pipeline_runs_created_idx ON pipeline_runs(created_at DESC);

CREATE TABLE pipeline_stages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  stage       text NOT NULL CHECK (stage IN ('idea', 'research', 'script', 'storyboard', 'assets', 'voice', 'draft', 'render',
                                             'qc', 'approval', 'upload', 'claim-watch', 'publish', 'learn')),
  state       text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'passed', 'failed', 'waiting-human', 'skipped')),
  attempt     int NOT NULL DEFAULT 1,
  output      jsonb NOT NULL DEFAULT '{}',
  error       text,
  started_at  timestamptz,
  finished_at timestamptz,
  UNIQUE (run_id, stage, attempt)
);

CREATE TABLE work_orders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     uuid NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  stage      text NOT NULL,
  shot_ref   text,
  executor   text NOT NULL CHECK (executor IN ('hermes-image', 'muse-agent', 'router', 'worker-tool', 'library')),
  spec       jsonb NOT NULL DEFAULT '{}',
  state      text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  job_id     uuid REFERENCES jobs(id) ON DELETE SET NULL,
  asset_id   uuid REFERENCES assets(id) ON DELETE SET NULL,
  attempts   int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_orders_run_idx ON work_orders(run_id);

-- One row per gate result. A QC job on a production has no run yet, so run_id is optional and production_id, job_id are kept too.
CREATE TABLE qc_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  production_id uuid REFERENCES productions(id) ON DELETE SET NULL,
  job_id        uuid REFERENCES jobs(id) ON DELETE SET NULL,
  asset_id      uuid REFERENCES assets(id) ON DELETE SET NULL,
  gate          text NOT NULL CHECK (gate IN ('G-script', 'G-storyboard', 'G-assets', 'G-voice', 'G-technical',
                                              'G-presentation', 'G-compliance', 'G-claims')),
  passed        boolean NOT NULL,
  score         int,
  details       jsonb NOT NULL DEFAULT '{}',
  executor      text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX qc_reports_production_idx ON qc_reports(production_id, created_at DESC);

CREATE TABLE template_trials (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id         text NOT NULL,
  version             int NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('lab', 'production')),
  passed_technical    boolean NOT NULL,
  presentation_score  int,
  asset_failures      int NOT NULL DEFAULT 0,
  compliance_failures int NOT NULL DEFAULT 0,
  claim               boolean NOT NULL DEFAULT false,
  qc_report_id        uuid REFERENCES qc_reports(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (template_id, version) REFERENCES template_versions(template_id, version) ON DELETE CASCADE
);
CREATE INDEX template_trials_template_idx ON template_trials(template_id, version);

-- Autonomy is set per channel by the owner. Level 1 (the owner approves ideas and uploads) is the default.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS autonomy_level smallint NOT NULL DEFAULT 1 CHECK (autonomy_level BETWEEN 0 AND 3);
ALTER TABLE channels ADD COLUMN IF NOT EXISTS autonomy_paused boolean NOT NULL DEFAULT false;

ALTER TABLE productions ADD COLUMN IF NOT EXISTS template_id text;
ALTER TABLE productions ADD COLUMN IF NOT EXISTS template_version int;
