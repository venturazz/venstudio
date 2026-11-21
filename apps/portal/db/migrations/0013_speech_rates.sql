-- Measured speech rate per voice. See docs/architecture-autonomous-studio.md ("Voice length").
--
-- Every narration and every Settings "Test voice" whose length was measured adds one row: how many words the voice
-- (provider + model + voice) spoke in how many seconds. The script, storyboard and voice checks plan with the median
-- of the newest rows for the run's voice instead of a fixed 150 words per minute. Additive only: a new table, no
-- existing column or row changes. Rows are small and written by the portal only, never from a model's claim.

CREATE TABLE IF NOT EXISTS voice_speech_rates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voice_key   text NOT NULL CHECK (length(voice_key) BETWEEN 1 AND 400),
  provider    text NOT NULL DEFAULT '',
  model       text NOT NULL DEFAULT '',
  voice       text NOT NULL DEFAULT '',
  language    text NOT NULL DEFAULT '',
  words       integer NOT NULL CHECK (words > 0),
  seconds     double precision NOT NULL CHECK (seconds > 0),
  wpm         double precision NOT NULL CHECK (wpm > 0 AND wpm < 1000),
  source      text NOT NULL CHECK (source IN ('narration', 'test')),
  run_id      uuid REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_speech_rates_key_idx ON voice_speech_rates (voice_key, created_at DESC);
CREATE INDEX IF NOT EXISTS voice_speech_rates_language_idx ON voice_speech_rates (language, created_at DESC);
