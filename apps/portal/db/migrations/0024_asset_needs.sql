-- What a video reached for and the library did not have.
--
-- This is how the library grows with use instead of by guesswork: every run that wanted a mystery bed, a riser, or rain
-- atmosphere and found nothing increments a counter here. The finder reads this table first, so the next assets it looks
-- for are the ones that actually blocked videos — not the ones that sounded like a good idea.
--
-- One row per (class, tag). `videos` is how many runs were blocked, which is the only ordering that matters.

CREATE TABLE asset_needs (
  asset_class      text NOT NULL CHECK (asset_class IN ('music', 'sfx', 'ambience')),
  tag              text NOT NULL,
  videos           integer NOT NULL DEFAULT 1 CHECK (videos > 0),
  note             text NOT NULL DEFAULT '',
  first_seen       timestamptz NOT NULL DEFAULT now(),
  last_seen        timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  resolved_asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
  PRIMARY KEY (asset_class, tag)
);

CREATE INDEX asset_needs_open_idx ON asset_needs (videos DESC) WHERE resolved_at IS NULL;
