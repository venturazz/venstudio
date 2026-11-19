-- Hermes pacing and endpoint health. See docs/architecture-autonomous-studio.md (Pacing and endpoint health).

-- One row: the shared Hermes call gate's "busy until" time, so a rate limit survives a portal restart.
CREATE TABLE IF NOT EXISTS hermes_gate (
  id           text PRIMARY KEY DEFAULT 'hermes' CHECK (id = 'hermes'),
  busy_until   timestamptz,
  consecutive  integer NOT NULL DEFAULT 0,
  last_status  integer,
  last_reason  text NOT NULL DEFAULT '',
  updated_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO hermes_gate (id) VALUES ('hermes') ON CONFLICT (id) DO NOTHING;

-- What real calls showed per endpoint and model. A model is proven only by a real success; a 4xx client error sets it
-- aside (quarantined_at). Written by productions and Settings tests, never by a model's claim.
CREATE TABLE IF NOT EXISTS endpoint_health (
  endpoint        text NOT NULL CHECK (endpoint IN ('9router', 'hermes')),
  model           text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('image', 'tts')),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_class   text CHECK (failure_class IN ('busy', 'auth', 'client', 'server', 'unreachable', 'content')),
  last_error      text NOT NULL DEFAULT '',
  quarantined_at  timestamptz,
  successes       integer NOT NULL DEFAULT 0,
  failures        integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (endpoint, model, kind)
);

-- A stage or work order that waits for a busy Hermes is pending with a not-before time instead of failing.
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS not_before timestamptz;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS not_before timestamptz;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS wait_reason text;
