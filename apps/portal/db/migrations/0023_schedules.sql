-- AutoStudio: a schedule fills the same New Video form, on a clock, for one channel.
--
-- What is deliberately absent: a second copy of how many videos a day (that is channels.videos_per_day), a cron
-- expression (three plain day forms are enough and cannot be misread), and a slot table. The schedule_id/slot_at pair on
-- pipeline_runs is the whole idempotency story: one run per slot, ever, enforced by the database rather than by a script
-- that might tick twice.

CREATE TABLE schedules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id   uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'one-off' CHECK (kind IN ('series', 'one-off')),

  -- The same answers New Video asks for, kept as a template: {themeId, styleId, durationSec, language, purposes,
  -- subtitles, sound}. The number of times is not here.
  settings     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- {topicSource: 'plan'|'owner'|'series-memory', topic?, mustInclude?, mustAvoid?}
  brief        jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 'daily' | 'weekly:mon,thu' | 'every:2'. Checked again in lib/studio/schedule.ts, which is what the scheduler reads.
  days         text NOT NULL DEFAULT 'daily',
  -- One HH:MM per video in the day, in this zone's wall clock. Length is kept equal to channels.videos_per_day.
  times_of_day text[] NOT NULL DEFAULT ARRAY['07:00']::text[],
  timezone     text NOT NULL DEFAULT 'Asia/Jakarta',
  -- 1 = tomorrow's slot only. The owner asked for daily, not a week of bookings.
  slots_ahead  integer NOT NULL DEFAULT 1 CHECK (slots_ahead BETWEEN 1 AND 14),

  -- Stages this schedule may pass without the owner. Empty: the schedule still stops where autonomy.ts stops.
  gate_stages  text[] NOT NULL DEFAULT '{}'::text[],
  -- {maxWorkerHoursPerDay}; a ceiling on render cost, not a count of videos.
  budget       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- {afterFailures: 2} -> the schedule pauses itself and leaves one review item.
  stop_rules   jsonb NOT NULL DEFAULT '{"afterFailures": 2}'::jsonb,

  state        text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'armed', 'paused')),
  series_id    uuid,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX schedules_channel_idx ON schedules (channel_id);
CREATE INDEX schedules_due_idx ON schedules (state, channel_id) WHERE state = 'armed';

-- Which slot a run came from. Nullable: every run started by hand has neither.
ALTER TABLE pipeline_runs ADD COLUMN schedule_id uuid REFERENCES schedules(id) ON DELETE SET NULL;
ALTER TABLE pipeline_runs ADD COLUMN slot_at timestamptz;

-- The guarantee, in one line: two ticks at the same moment cannot both produce a run for one slot.
CREATE UNIQUE INDEX pipeline_runs_slot_once ON pipeline_runs (schedule_id, slot_at) WHERE schedule_id IS NOT NULL;