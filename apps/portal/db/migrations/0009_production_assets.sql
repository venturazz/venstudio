-- Phase 4: production assets. Provider licence terms the owner confirms, and result tracking on work orders.
-- See docs/architecture-autonomous-studio.md.

-- One row per provider and kind. A provider is added as 'unknown' the first time an asset from it is seen.
-- Only the owner changes commercial_ok, from Settings. Nothing writes 'yes' or 'no' automatically.
CREATE TABLE IF NOT EXISTS asset_providers (
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('image', 'tts', 'library')),
  commercial_ok text NOT NULL DEFAULT 'unknown' CHECK (commercial_ok IN ('unknown', 'yes', 'no')),
  note          text NOT NULL DEFAULT '',
  confirmed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, kind)
);

ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS result jsonb;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS work_orders_run_state_idx ON work_orders(run_id, state);
