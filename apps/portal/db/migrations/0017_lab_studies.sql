-- Style system Phase 3: the Template Lab (docs/template-lab.md). Additive only: two new tables, no existing column or
-- row changes. A run started as a trial from a study carries pipeline_runs.config.labStudyId (additive JSON).
--
-- lab_studies   one study toward a new or improved style pack: the owner's notes, Hermes's current draft pack spec
--               (validated JSON, lib/studio/lab-study.ts), and the revision loop (at most 5 revisions).
-- lab_sources   what the study learns from. A link, an article, a repository or a skill is stored as a reference
--               only (URL, path, name): Hermes looks at it with its own tools and only its pattern notes are kept in
--               `findings`. Nothing is downloaded and no frame, audio or script is stored. An upload points at an
--               asset the owner holds rights to and its analyze-video job (numbers only). Every source records its
--               licence ("unknown" for links and articles nobody recorded) and its status.
CREATE TABLE IF NOT EXISTS lab_studies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  goal           text NOT NULL DEFAULT 'new' CHECK (goal IN ('new', 'improve')),
  base_pack      text CHECK (base_pack IS NULL OR base_pack ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  notes          text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  -- Hermes's current draft pack spec; null until the first synthesis.
  draft          jsonb CHECK (draft IS NULL OR jsonb_typeof(draft) = 'object'),
  -- none: never asked; working: Hermes is drafting; ready: `draft` is current; failed: see draft_error.
  draft_state    text NOT NULL DEFAULT 'none' CHECK (draft_state IN ('none', 'working', 'ready', 'failed')),
  draft_error    text,
  draft_at       timestamptz,
  -- 0 for the first draft, then one per owner-requested revision (lib/studio/template-lab.ts MAX_LAB_REVISIONS).
  revision       int NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 5),
  -- [{ revision, note, at }]: the owner notes sent back to Hermes, in order.
  revisions      jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(revisions) = 'array'),
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lab_sources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id         uuid NOT NULL REFERENCES lab_studies(id) ON DELETE CASCADE,
  type             text NOT NULL CHECK (type IN ('upload', 'link', 'repo', 'skill', 'article', 'owner-note')),
  -- The URL, skill name, asset id or note. A reference, never the material.
  ref              text NOT NULL CHECK (length(ref) BETWEEN 1 AND 2000),
  ref_path         text CHECK (ref_path IS NULL OR length(ref_path) <= 200),
  licence          text NOT NULL CHECK (length(licence) BETWEEN 1 AND 200),
  asset_id         uuid REFERENCES assets(id) ON DELETE SET NULL,
  analysis_job_id  uuid REFERENCES jobs(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'analyzed', 'failed')),
  -- Why it failed, or why it is still waiting (e.g. Hermes is rate limited).
  reason           text,
  -- Hermes's validated pattern notes, or the measured numbers of an upload, or nothing.
  findings         jsonb CHECK (findings IS NULL OR jsonb_typeof(findings) = 'object'),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (type NOT IN ('link', 'repo', 'article') OR ref ~* '^https?://'),
  CHECK (status <> 'failed' OR reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS lab_sources_study_idx ON lab_sources(study_id, created_at);
CREATE INDEX IF NOT EXISTS pipeline_runs_lab_study_idx ON pipeline_runs((config->>'labStudyId')) WHERE config ? 'labStudyId';
