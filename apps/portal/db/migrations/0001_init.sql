-- VenStudio initial schema. Requires PostgreSQL 13+ (gen_random_uuid is built in).

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE CHECK (email = lower(email)),
  name            text NOT NULL,
  role            text NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'editor', 'viewer')),
  password_hash   text NOT NULL,
  totp_secret_enc text,
  totp_enabled    boolean NOT NULL DEFAULT false,
  totp_last_counter bigint,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  mfa_pending   boolean NOT NULL DEFAULT false,
  ip            text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE login_attempts (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL,
  ip         text NOT NULL,
  success    boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_idx ON login_attempts(email, created_at);
CREATE INDEX login_attempts_ip_idx ON login_attempts(ip, created_at);

CREATE TABLE workers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  host          text NOT NULL DEFAULT 'muse' CHECK (host IN ('muse', 'vps', 'local')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draining', 'revoked')),
  token_hash    text UNIQUE,
  capabilities  text[] NOT NULL DEFAULT '{}',
  mode          text CHECK (mode IN ('tick', 'daemon')),
  version       text,
  last_seen_at  timestamptz,
  last_ip       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);

CREATE TABLE enrollment_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash   text NOT NULL UNIQUE,
  label       text NOT NULL,
  host        text NOT NULL DEFAULT 'muse' CHECK (host IN ('muse', 'vps', 'local')),
  channel_id  uuid,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  worker_id   uuid REFERENCES workers(id) ON DELETE SET NULL
);

CREATE TABLE channels (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  handle             text,
  niche              text NOT NULL DEFAULT '',
  format             text NOT NULL DEFAULT '',
  language           text NOT NULL DEFAULT 'en',
  google_account     text NOT NULL DEFAULT '',
  status             text NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'active', 'paused')),
  videos_per_day     integer NOT NULL DEFAULT 2 CHECK (videos_per_day BETWEEN 0 AND 24),
  home_worker_id     uuid REFERENCES workers(id) ON DELETE SET NULL,
  youtube_channel_id text,
  notes              text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE enrollment_codes
  ADD CONSTRAINT enrollment_codes_channel_fk FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL;

CREATE TABLE jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type                text NOT NULL,
  capability          text NOT NULL,
  status              text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  priority            integer NOT NULL DEFAULT 0,
  payload             jsonb NOT NULL DEFAULT '{}',
  result              jsonb,
  channel_id          uuid REFERENCES channels(id) ON DELETE SET NULL,
  preferred_worker_id uuid REFERENCES workers(id) ON DELETE SET NULL,
  worker_id           uuid REFERENCES workers(id) ON DELETE SET NULL,
  attempts            integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 3,
  lease_expires_at    timestamptz,
  progress            real NOT NULL DEFAULT 0,
  message             text,
  error               text,
  cancel_requested    boolean NOT NULL DEFAULT false,
  run_after           timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz
);
CREATE INDEX jobs_queue_idx ON jobs(status, capability, run_after) WHERE status = 'queued';
CREATE INDEX jobs_running_idx ON jobs(lease_expires_at) WHERE status = 'running';
CREATE INDEX jobs_created_idx ON jobs(created_at DESC);

CREATE TABLE job_events (
  id         bigserial PRIMARY KEY,
  job_id     uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  level      text NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
  message    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_events_job_idx ON job_events(job_id, id);

CREATE TABLE artifacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name          text NOT NULL,
  content_type  text NOT NULL,
  bytes         bigint NOT NULL,
  sha256        text NOT NULL,
  storage_path  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, name)
);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  worker_id  uuid REFERENCES workers(id) ON DELETE SET NULL,
  action     text NOT NULL,
  target     text,
  detail     jsonb NOT NULL DEFAULT '{}',
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log(created_at DESC);
