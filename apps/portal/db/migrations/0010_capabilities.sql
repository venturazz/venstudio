-- Live capability scan: what Hermes (skills, tools) and 9router (models) can do for each production stage.
-- One row, replaced by every scan. Pages read only this row and never call Hermes or 9router to render.
-- See docs/architecture-autonomous-studio.md (Capabilities).
CREATE TABLE capability_scans (
  id         text PRIMARY KEY DEFAULT 'current' CHECK (id = 'current'),
  scanned_at timestamptz NOT NULL,
  hermes     jsonb,
  router     jsonb,
  error      text
);
