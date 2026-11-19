-- Worker hold mode (stays online ~55 min per Muse hourly task).
ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_mode_check;
ALTER TABLE workers ADD CONSTRAINT workers_mode_check CHECK (mode IN ('tick', 'hold', 'daemon'));

-- When the worker last asked for work. Separate from last_seen_at, which any request updates.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS last_claim_at timestamptz;
